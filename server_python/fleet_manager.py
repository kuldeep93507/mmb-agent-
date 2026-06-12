"""
fleet_manager — Multi-laptop (fleet) control.

Design (see planning/05_fleet_multi_laptop.md):
  - Each laptop runs THIS backend = a fleet "agent".
  - One laptop acts as "controller": registers the other laptops (Tailscale
    IP + API key) and fans out commands to them in parallel.
  - Registry stored in data/fleet_machines.json.
  - NO new dependency — uses stdlib urllib + ThreadPoolExecutor.
  - NOTHING here touches existing single-machine behaviour.
"""
from __future__ import annotations

import json
import logging
import socket
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

log = logging.getLogger("mmb.fleet")

_ROOT = Path(__file__).resolve().parent.parent
_MACHINES_FILE = _ROOT / "data" / "fleet_machines.json"
_KEY_FILE = _ROOT / "data" / "fleet_agent_key.txt"
_TIMEOUT = 6.0


# ── This laptop's API key (controllers use it to connect to this agent) ────────

def get_agent_key() -> str:
    """This laptop's fleet API key. Falls back to BACKEND_API_KEY env/default."""
    import os
    try:
        if _KEY_FILE.exists():
            k = _KEY_FILE.read_text(encoding="utf-8").strip()
            if k:
                return k
    except Exception:
        pass
    return os.getenv("BACKEND_API_KEY", "mmb-local-dev-2025")


def regenerate_agent_key() -> str:
    """Generate a fresh random key, persist it, return it."""
    import secrets
    key = "mmb-" + secrets.token_hex(16)
    _KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    _KEY_FILE.write_text(key, encoding="utf-8")
    log.info("[Fleet] Agent API key regenerated")
    return key


def get_local_ips() -> list[str]:
    """Best-effort list of this machine's reachable IPs (LAN + Tailscale)."""
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None):
            ip = info[4][0]
            if ":" in ip:  # skip IPv6
                continue
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    # also the primary outbound IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip not in ips:
            ips.insert(0, ip)
    except Exception:
        pass
    return ips


def get_this_laptop() -> dict:
    """Connection info for THIS laptop — shown on its own Fleet page."""
    ips = get_local_ips()
    tailscale = [ip for ip in ips if ip.startswith("100.")]
    lan = [ip for ip in ips if not ip.startswith("100.")]
    return {
        "hostname": socket.gethostname(),
        "apiKey": get_agent_key(),
        "lanIps": lan,
        "tailscaleIps": tailscale,
        "port": 3100,
        "suggestedAddress": (tailscale[0] if tailscale else (lan[0] if lan else "127.0.0.1")) + ":3100",
    }


# ── Registry ──────────────────────────────────────────────────────────────────

def _load() -> list[dict]:
    try:
        if _MACHINES_FILE.exists():
            data = json.loads(_MACHINES_FILE.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
    except Exception as e:
        log.warning("fleet machines load failed: %s", e)
    return []


def _save(machines: list[dict]) -> None:
    _MACHINES_FILE.parent.mkdir(parents=True, exist_ok=True)
    _MACHINES_FILE.write_text(json.dumps(machines, indent=2, ensure_ascii=False), encoding="utf-8")


def list_machines() -> list[dict]:
    return _load()


def add_machine(name: str, address: str, api_key: str = "") -> dict:
    """address = 'host:port' or 'host' (defaults port 3100)."""
    address = address.strip()
    if ":" not in address:
        address = f"{address}:3100"
    machines = _load()
    mid = f"m{int(time.time() * 1000)}"
    rec = {"id": mid, "name": name.strip() or address, "address": address, "apiKey": api_key.strip()}
    machines.append(rec)
    _save(machines)
    log.info("[Fleet] Added machine %s (%s)", rec["name"], address)
    return rec


def remove_machine(mid: str) -> bool:
    machines = _load()
    new = [m for m in machines if m.get("id") != mid]
    if len(new) == len(machines):
        return False
    _save(new)
    return True


# ── Local agent identity (what THIS laptop reports) ─────────────────────────────

def get_local_agent_info() -> dict:
    """Summary of THIS machine — reused by /api/agent/info."""
    name = socket.gethostname()
    profiles_total = 0
    running = 0
    profiles: list[dict] = []
    try:
        from server_python.worker_manager import worker_manager
        statuses = worker_manager.get_all_statuses()
        if isinstance(statuses, dict):
            statuses = list(statuses.values())
        for w in (statuses or []):
            profiles_total += 1
            st = str(w.get("status", "")).lower()
            if st in ("running", "watching", "connecting", "starting"):
                running += 1
            profiles.append({
                "id": w.get("profileId") or w.get("id") or "",
                "name": w.get("profileName") or w.get("name") or "",
                "status": st or "idle",
                "video": w.get("currentVideo") or w.get("videoTitle") or "",
            })
    except Exception as e:
        log.debug("get_local_agent_info workers read failed: %s", e)
    return {
        "hostname": name,
        "profilesTotal": profiles_total,
        "running": running,
        "profiles": profiles,
        "ts": int(time.time()),
    }


# ── Remote calls (controller → agents) ─────────────────────────────────────────

def _call_agent(machine: dict, path: str, method: str = "GET", body: dict | None = None) -> dict:
    addr = machine.get("address", "")
    url = f"http://{addr}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-api-key", machine.get("apiKey", "") or "")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_agent_status(machine: dict) -> dict:
    """One agent's live status (online + info). Never raises."""
    base = {"id": machine.get("id"), "name": machine.get("name"), "address": machine.get("address")}
    try:
        info = _call_agent(machine, "/api/agent/info")
        return {**base, "online": True, **info}
    except Exception as e:
        return {**base, "online": False, "error": str(e)[:120],
                "profilesTotal": 0, "running": 0, "profiles": []}


def get_fleet_status() -> dict:
    """Parallel-fetch all registered machines + include THIS machine."""
    machines = _load()
    results: list[dict] = []
    if machines:
        with ThreadPoolExecutor(max_workers=min(10, len(machines))) as ex:
            futs = {ex.submit(fetch_agent_status, m): m for m in machines}
            for f in as_completed(futs):
                results.append(f.result())
    # keep registry order
    order = {m["id"]: i for i, m in enumerate(machines)}
    results.sort(key=lambda r: order.get(r.get("id"), 999))
    online = sum(1 for r in results if r.get("online"))
    return {
        "machines": results,
        "onlineCount": online,
        "totalCount": len(results),
        "totalProfiles": sum(r.get("profilesTotal", 0) for r in results),
        "totalRunning": sum(r.get("running", 0) for r in results),
    }


def test_connection(address: str, api_key: str = "") -> dict:
    """Ping remote agent /api/health (+ /api/agent/info if key works). Never raises."""
    address = (address or "").strip()
    if not address:
        return {"ok": False, "online": False, "error": "Address required"}
    if ":" not in address:
        address = f"{address}:3100"
    machine = {"address": address, "apiKey": (api_key or "").strip()}
    base = {"address": address}
    try:
        health = _call_agent(machine, "/api/health")
        base["health"] = health
        base["online"] = True
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:120]
        except Exception:
            pass
        if e.code == 401:
            return {**base, "ok": False, "online": True, "error": "Unauthorized — galat API key", "detail": body}
        return {**base, "ok": False, "online": True, "error": f"HTTP {e.code}", "detail": body}
    except Exception as e:
        return {**base, "ok": False, "online": False, "error": str(e)[:160]}

    if machine.get("apiKey"):
        try:
            info = _call_agent(machine, "/api/agent/info")
            base["agent"] = {
                "hostname": info.get("hostname"),
                "profilesTotal": info.get("profilesTotal", 0),
                "running": info.get("running", 0),
            }
        except urllib.error.HTTPError as e:
            if e.code == 401:
                return {**base, "ok": False, "online": True, "error": "Health OK — par API key galat hai (401)"}
            return {**base, "ok": False, "online": True, "error": f"Agent info HTTP {e.code}"}
        except Exception as e:
            return {**base, "ok": False, "online": True, "error": f"Health OK — agent info fail: {str(e)[:80]}"}

    return {**base, "ok": True, "online": True, "message": "Connected ✓"}


def broadcast(machine_ids: list[str], path: str, body: dict | None = None) -> dict:
    """
    Fan-out a POST to selected machines in parallel. Returns per-machine result.
    `path` = an existing agent endpoint (e.g. /api/engagement/start).
    Partial failures don't stop others.

    Optional per-machine fields inside payload:
      perMachineProfiles: { machineId: [profileId, ...] }
      perMachineProfileTraffic: { machineId: { profileId: trafficLabel } }
      perMachineGap: { machineId: { gapMin, gapMax } }
      laptopStaggerMin / laptopStaggerMax — seconds between laptop start (run-engagement only)
    """
    import random as _rand
    raw = body or {}
    payload_base = dict(raw.get("payload") or raw)
    per_machine_profiles = dict(payload_base.pop("perMachineProfiles", None) or {})
    per_machine_traffic = dict(payload_base.pop("perMachineProfileTraffic", None) or {})
    per_machine_actions = dict(payload_base.pop("perMachineProfileActions", None) or {})
    per_machine_gap = dict(payload_base.pop("perMachineGap", None) or {})
    laptop_stagger_min = float(payload_base.pop("laptopStaggerMin", 0) or 0)
    laptop_stagger_max = float(payload_base.pop("laptopStaggerMax", 0) or 0)
    use_laptop_stagger = (
        path.endswith("/run-engagement")
        and laptop_stagger_max > 0
        and laptop_stagger_max >= laptop_stagger_min
    )

    machines = [m for m in _load() if m.get("id") in set(machine_ids)]
    out: list[dict] = []

    def _payload_for(m: dict) -> dict:
        mid = str(m.get("id") or "")
        mp = dict(payload_base)
        if mid in per_machine_profiles:
            mp["selectedProfileIds"] = list(per_machine_profiles[mid])
        if mid in per_machine_traffic:
            mp["perProfileTraffic"] = dict(per_machine_traffic[mid])
        if mid in per_machine_actions:
            mp["perProfileActions"] = dict(per_machine_actions[mid])
        if mid in per_machine_gap:
            g = per_machine_gap[mid]
            if g.get("gapMin") is not None:
                mp["gapMin"] = int(g["gapMin"])
            if g.get("gapMax") is not None:
                mp["gapMax"] = int(g["gapMax"])
        return mp

    if machines:
        if use_laptop_stagger:
            for i, m in enumerate(machines):
                if i > 0:
                    wait = _rand.uniform(laptop_stagger_min, laptop_stagger_max)
                    log.info("[Fleet] Laptop stagger %.1fs before %s", wait, m.get("name"))
                    time.sleep(wait)
                try:
                    res = _call_agent(m, path, "POST", _payload_for(m))
                    out.append({"id": m["id"], "name": m["name"], "ok": True, "result": res})
                except Exception as e:
                    out.append({"id": m["id"], "name": m["name"], "ok": False, "error": str(e)[:160]})
        else:
            with ThreadPoolExecutor(max_workers=min(10, len(machines))) as ex:
                futs = {ex.submit(_call_agent, m, path, "POST", _payload_for(m)): m for m in machines}
                for f in as_completed(futs):
                    m = futs[f]
                    try:
                        res = f.result()
                        out.append({"id": m["id"], "name": m["name"], "ok": True, "result": res})
                    except Exception as e:
                        out.append({"id": m["id"], "name": m["name"], "ok": False, "error": str(e)[:160]})
    ok = sum(1 for r in out if r.get("ok"))
    return {"sent": len(out), "ok": ok, "failed": len(out) - ok, "results": out}
