"""
ONE-OFF DIAGNOSTIC — CDP mouse-coordinate bug test.

Kya karta hai (sirf test, project code nahi chhedta):
  1. Multilogin profile kholta hai (CDP port leta hai)
  2. about:blank pe ek click listener inject karta hai (screenX/clientX capture)
  3. CDP se ek click karta hai (wahi dispatch_mouse_event jo project use karta hai)
  4. Captured screenX vs clientX compare karta hai
  5. Verdict: BUG (screenX==clientX) ya SAFE (alag hain)

Run: python tests/test_cdp_coords.py
Pehle Multilogin + backend chalu rakho (taaki token/env load ho).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PROFILE = os.getenv("MMB_TEST_PROFILE", "c58a40dc-d6ff-4234-8d26-a592804d32ea")


def _load_env() -> None:
    """Load .env + multiloginToken from user-settings.json into env (like backend)."""
    try:
        from dotenv import load_dotenv
        envp = ROOT / ".env"
        if envp.exists():
            load_dotenv(envp, override=True)
    except Exception:
        pass
    try:
        s = json.loads((ROOT / "user-settings.json").read_text(encoding="utf-8"))
        if s.get("multiloginToken") and not os.getenv("MULTILOGIN_TOKEN"):
            os.environ["MULTILOGIN_TOKEN"] = str(s["multiloginToken"])
        for k_src, k_env in (("multiloginEmail", "MULTILOGIN_EMAIL"),
                             ("multiloginPassword", "MULTILOGIN_PASSWORD"),
                             ("multiloginFolderId", "MULTILOGIN_FOLDER_ID")):
            if s.get(k_src) and not os.getenv(k_env):
                os.environ[k_env] = str(s[k_src])
    except Exception:
        pass


LISTENER_JS = """
(() => {
  window.__clk = null;
  document.addEventListener('click', function(e){
    window.__clk = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY,
                     trusted: e.isTrusted };
  }, true);
  document.title = 'cdp-coord-test';
  return true;
})()
"""

READ_JS = "(() => JSON.stringify(window.__clk))()"


async def main() -> int:
    _load_env()
    print("=" * 60)
    print("  CDP COORDINATE BUG TEST")
    print(f"  profile: {PROFILE}")
    print("=" * 60)

    if not os.getenv("MULTILOGIN_TOKEN"):
        print("FAIL: MULTILOGIN_TOKEN nahi mila (.env / user-settings.json) — Multilogin login karo")
        return 1

    try:
        import nodriver as uc
        from nodriver import cdp
    except Exception as e:
        print(f"FAIL: nodriver import — {e}")
        return 1

    from server_python.providers.multilogin import MultiloginProvider

    provider = MultiloginProvider(
        token=os.getenv("MULTILOGIN_TOKEN", ""),
        email=os.getenv("MULTILOGIN_EMAIL", ""),
        password=os.getenv("MULTILOGIN_PASSWORD", ""),
        folder_id=os.getenv("MULTILOGIN_FOLDER_ID", ""),
    )

    print("Profile start kar raha hoon (Multilogin)...")
    started = await provider.start_profile(PROFILE)
    _d = started.get("data") if isinstance(started.get("data"), dict) else {}
    port = started.get("cdpPort") or started.get("port") or _d.get("cdpPort") or _d.get("port")
    if not port:
        print(f"FAIL start: {started}")
        return 1
    print(f"CDP port: {port} — attach kar raha hoon...")

    browser = await uc.start(host="127.0.0.1", port=int(port), headless=False)
    tab = browser.tabs[0] if browser.tabs else await browser.get("about:blank")
    await tab.get("about:blank")
    await asyncio.sleep(1.5)
    await tab.evaluate(LISTENER_JS, return_by_value=True)
    await asyncio.sleep(0.5)

    # CDP click at a known viewport point (same path as project)
    x, y = 250.0, 250.0
    print(f"CDP click @ ({x},{y}) ...")
    await tab.send(cdp.input_.dispatch_mouse_event(type_="mouseMoved", x=x, y=y))
    await asyncio.sleep(0.1)
    await tab.send(cdp.input_.dispatch_mouse_event(
        type_="mousePressed", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
    await asyncio.sleep(0.08)
    await tab.send(cdp.input_.dispatch_mouse_event(
        type_="mouseReleased", x=x, y=y, button=cdp.input_.MouseButton.LEFT, click_count=1))
    await asyncio.sleep(1.0)

    raw = await tab.evaluate(READ_JS, return_by_value=True)
    val = getattr(raw, "value", raw)
    data = json.loads(val) if isinstance(val, str) and val and val != "null" else None

    print("\n" + "=" * 60)
    if not data:
        print("  RESULT: INCONCLUSIVE — click event capture nahi hua")
        rc = 2
    else:
        sx, sy, cx, cy = data["sx"], data["sy"], data["cx"], data["cy"]
        print(f"  clientX/clientY : {cx} / {cy}   (page position)")
        print(f"  screenX/screenY : {sx} / {sy}   (screen position)")
        print(f"  isTrusted       : {data.get('trusted')}")
        print("-" * 60)
        if sx == cx and sy == cy:
            print("  RESULT: 🔴 BUG CONFIRMED — screenX==clientX (CDP coordinate")
            print("          detectable; real human click pe ye alag hote hain)")
            rc = 1
        else:
            print(f"  RESULT: ✅ SAFE — screenX!=clientX (offset = {sx-cx},{sy-cy})")
            print("          Multilogin coordinate normalize kar raha hai")
            rc = 0
    print("=" * 60)

    try:
        await provider.stop_profile(PROFILE)
    except Exception:
        pass
    return rc


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
