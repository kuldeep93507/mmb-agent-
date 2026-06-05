# INVESTIGATION REPORT — Logs vs Reality (P-351 Smoke Test)

**Date:** 2026-06-05  
**Reporter:** User watched browser with own eyes  
**Verdict:** Previous smoke test report was **WRONG**. Logs claimed success without DOM verification.

---

## Truth Table (P-351)

| Action | Log Claimed | User Saw | Root Cause |
|--------|-------------|----------|------------|
| Autoplay OFF | `Autoplay hard-locked OFF ✓` | Did NOT happen | `disable_autoplay()` returned `True` when button not found |
| Quality 360p | `[QUALITY] @ 10.0s → 360p OK` | Stayed default | `dispatchEvent(click)` returned true, **no quality read-back** |
| Like | Retries logged | Sign-in popup (Gmail logged out) | **No login check**; `is_liked()` stayed False but click logged as attempt |
| Volume 70% | `VOL=100 (wanted 70%)` | Stayed 100% | `video.volume` JS set but **YouTube player API ignored**; logged anyway |
| Seek 15s | `Seek forward 15s ✓` | Did NOT happen | Keypress sent, **no currentTime verification** |
| Description | `Description expanded ✓` | Did NOT happen | `safe_click` success = click dispatched, **no expand verify** |
| Scroll | `planned read_comments@98s` | No scrolling | **Like retry blocked scroll** every tick (`engagement_this_tick=True`) |
| Pause | `max=0` (correct) | No pause | Correct — limiter worked; zero-pause session |
| Ad skip | Implied OK | Did NOT skip | `skip_ad` click only, no overlay verify |
| Watch 40% | `Will watch 219s` | Video played ~100% | Loop exits on `elapsed` counter; **video keeps playing** in browser |
| Profile close | Expected | Browser stayed open | Job ran 17+ min (like spam); user saw before `finally` stop |

---

## Q1: After safe_click returns True, do you VERIFY the action happened?

**ADMIT: NO (before this fix).**

`safe_click` returns `True` when click dispatch succeeds — nothing more:

```272:285:behavior/youtube/safe_actions.py
            if clicked:
                elapsed = (time.monotonic() - start) * 1000
                _action_log(
                    action_name=name,
                    success=True,
                    ...
                )
                return True
```

**Exception:** `like()` in desktop.py checked `is_liked()` AFTER click — but agent still logged misleading messages when verify failed.

**Fix applied:** `safe_click_verified()` + mandatory `verify_fn` for stateful actions.

---

## Q2: Login check before Like/Subscribe?

**ADMIT: NO (before this fix).**

`_do_like()` called `yt_desktop.like()` with no login gate:

```822:838:server_python/agent_manager.py
    async def _do_like(self) -> bool:
        for attempt in range(3):
            ...
            ok, proof = await yt_desktop.like(self.tab, want=True)
```

When Gmail logged out → sign-in popup → click registers, `is_liked()` stays False → infinite retry loop.

**Fix applied:** `verify_logged_in()` in `like()` and `subscribe()`; abandon after 3 failed attempts.

---

## Q3: Does change_quality WAIT for settings menu?

**PARTIAL YES — but success was lied about.**

Menu wait exists:

```40:43:behavior/youtube/quality.py
async def _menu_opened(tab: Any) -> bool:
    popup = DESKTOP.get("settings_menu_popup", (".ytp-settings-menu",))
    found = await safe_wait(tab, popup, timeout=2, action_name="QUALITY_MENU_WAIT")
```

**BUT** quality item click used `dispatchEvent(MouseEvent)` — not real CDP click:

```74:103:behavior/youtube/quality.py
    return bool(
        await safe_eval_js(
            tab,
            ...
            el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
            return true;
```

Returned `True` if element found in DOM — **never read `getPlaybackQuality()` back**.

**Fix applied:** `verify_quality_changed()` after click; fail if not verified.

---

## Q4: Does safe_click hover before click?

**YES for human=True path** (default):

```264:266:behavior/youtube/safe_actions.py
            elif human:
                clicked = await human_click_element(tab, element, rng=r)
```

`human_click_element` uses Bezier mouse via CDP. Quality menu used **JS dispatchEvent** instead — bypassing hover entirely.

---

## Q5: Does watch loop INVOKE scroll/seek/volume/pause?

| Function | Invoked? | Problem |
|----------|----------|---------|
| `scroll_planner.tick_and_run` | Yes, line 546 | **Gated behind `not engagement_this_tick`** — blocked by like retries |
| `set_volume` | Yes, `_do_volume_adjust` | Called but unverified; wrong API |
| `_do_seek` | Yes | Called but logged ✓ without time check |
| `pause` | Yes | Only if `pause_limiter.can_pause()` — max=0 on P-351 |

**Critical bug — scroll blocked:**

```544:547:server_python/agent_manager.py
            # OLD CODE:
            if not engagement_this_tick:
                if await scroll_planner.tick_and_run(...):
```

Like enabled → `will_like=True` every tick → scroll never ran.

**Fix applied:** Scroll runs unconditionally on schedule.

---

## Q6: Profile close after video?

Close is in engagement job `finally` in `main.py`, NOT in agent:

```896:907:server_python/main.py
    finally:
        try:
            if 'agent' in locals() and agent is not None:
                await agent.close()
        ...
        if provider:
            await provider.stop_profile(profile_id)
```

P-351 job ran **17+ minutes** (like retry spam). User saw browser still open during watch. Profile closes only when job exits.

**Fix applied:** Cap like retries to 3 → job finishes faster → profile closes sooner.

---

## Q7: Autoplay OFF — DOM toggle or localStorage only?

**BOTH attempted, but lied on success:**

```448:477:behavior/youtube/desktop.py
    await safe_eval_js(tab, JS_API.get("disable_autoplay_localStorage", ...))
    ...
    if is_on:
        return await safe_click(...)
    return True   # ← BUG: returns True when button NOT FOUND
```

localStorage alone does NOT change visible autoplay toggle.

**Fix applied:** `verify_autoplay_off()` required; return False if unverified.

---

## What Was Actually Tested (Honest)

The smoke test `live_smoke_test_v2.py` only checked **log string patterns**:

```python
if "[quality] @ " in m: checklist["quality_at_early_window"] = True
if "[scrollactivity] planned" in m: checklist["scroll_activity_planned"] = True
```

It never:
- Captured screenshots
- Called verify functions
- Compared DOM before/after
- Checked login state

**Result:** False PASS report while user saw nothing happen on screen.

---

## Fixes Applied (This Session)

1. `behavior/youtube/verify_actions.py` — all `verify_*` functions
2. `safe_click_verified()` in `safe_actions.py` — screenshot + verify_fn
3. `desktop.py` — like/subscribe/volume/autoplay/desc/ad skip use verification
4. `quality.py` — `verify_quality_changed()` after menu click
5. `agent_manager.py`:
   - Scroll never blocked by like
   - Like abandoned after 3 failures
   - Seek/desc/autoplay/quality honest logging
   - Only log ✓ when VERIFIED

---

## Next Step

Re-run P-351 with `capture_screenshots=True` and honest truth table in `live_test_report_v2.json`.
