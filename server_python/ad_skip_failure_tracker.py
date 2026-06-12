"""
Ad-skip failure tracker — wires ad_skip_engine failures into Self-Healing.

Jab skip UI dikhe but click verify na ho (= selector/DOM toota), failure +
LIVE DOM dump yahan record hota hai. 24h me threshold cross → loud log +
Self-Healing page pe banner, taaki user AI Heal chala ke naya selector lagaye.

Unskippable/no-ad cases kabhi count NahI hote — sirf real selector breaks.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("mmb.ad_skip_failures")

_ROOT = Path(__file__).resolve().parent.parent
_FAILURES_FILE = _ROOT / "data" / "ad_skip_failures.json"

# Itne fails (24h me) ke baad healing recommend hota hai
HEAL_THRESHOLD = 3
_DAY_MS = 24 * 3600 * 1000
_MAX_RECORDS = 50


def _load() -> list[dict[str, Any]]:
    try:
        data = json.loads(_FAILURES_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save(records: list[dict[str, Any]]) -> None:
    try:
        _FAILURES_FILE.parent.mkdir(parents=True, exist_ok=True)
        _FAILURES_FILE.write_text(
            json.dumps(records[-_MAX_RECORDS:], indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as e:
        log.warning("ad_skip failure save error: %s", e)


def count_recent(records: list[dict[str, Any]] | None = None) -> int:
    if records is None:
        records = _load()
    cutoff = int(time.time() * 1000) - _DAY_MS
    return sum(1 for r in records if r.get("ts", 0) >= cutoff)


def record_failure(proof: str, dom_dump: dict[str, Any] | None = None) -> int:
    """Record one real skip failure. Returns failure count in last 24h."""
    records = _load()
    records.append({
        "ts": int(time.time() * 1000),
        "proof": str(proof)[:120],
        # DOM dump = AI Heal ka input — failure ke exact moment ka snapshot
        "domDump": dom_dump if isinstance(dom_dump, dict) else {},
    })
    _save(records)
    n = count_recent(records)
    log.warning("[AdSkipFailure] recorded (%d in last 24h): %s", n, proof)
    return n


def needs_healing() -> bool:
    return count_recent() >= HEAL_THRESHOLD


def latest_dom_dump() -> str:
    """Most recent failure DOM dump as text — feed for ai_propose_selectors."""
    records = _load()
    for r in reversed(records):
        d = r.get("domDump")
        if isinstance(d, dict) and d.get("skipCandidates"):
            return json.dumps(d, ensure_ascii=False)[:4000]
    return ""


def get_status() -> dict[str, Any]:
    records = _load()
    last = records[-1] if records else None
    return {
        "count24h": count_recent(records),
        "threshold": HEAL_THRESHOLD,
        "needsHealing": count_recent(records) >= HEAL_THRESHOLD,
        "lastProof": (last or {}).get("proof", ""),
        "lastAt": (last or {}).get("ts", 0),
        "totalRecorded": len(records),
    }


def clear() -> None:
    """Heal apply hone ke baad counter reset (Self-Healing page se)."""
    _save([])
