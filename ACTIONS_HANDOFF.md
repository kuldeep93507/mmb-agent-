# MMB Agent — Actions Handoff (read this first)

> **Purpose:** Any AI or developer can read this file once and know what works, what is locked, what is pending, and where the code lives.  
> **Last updated:** 2026-06-08  
> **Test profile:** `c58a40dc-d6ff-4234-8d26-a592804d32ea` (MMB test / Profile-32ea)  
> **Backend:** `http://127.0.0.1:3100` · API key: `mmb-local-dev-2025`

---

## 1. Action status matrix

| Action | Status | Live verified? | Notes |
|--------|--------|----------------|-------|
| Play / Pause | **LOCKED ✅** | Yes (prior sessions) | `yt_desktop.pause()` / `play()` via player API |
| Volume | **LOCKED ✅** | Yes | `_do_volume_adjust()` — audit sometimes false-neg |
| Captions (CC) | **LOCKED ✅** | Yes | `toggle_captions()` early setup |
| Like | **LOCKED ✅** | Yes | `_do_like()` |
| Subscribe | **LOCKED ✅** | Yes | `_do_subscribe()` |
| Bell | **LOCKED ✅** | Yes | `_do_bell()` |
| Comment post | **LOCKED ✅** | Yes | `_do_comment()` |
| Seek | **LOCKED ✅** | Yes | `_do_seek()` |
| Comment like | **VERIFIED ✅** | Yes — `2Vv-BfVoq4g` | `_do_comment_like()` + PostWatch retry |
| Description expand | **VERIFIED ✅** | Yes — `uFy7lhTpVXI` | `expand_description()` with poll retry |
| Autoplay OFF | **VERIFIED ✅** | Yes | Early setup, audit pass |
| Description links | **COMING SOON ⏸** | Partial only | Expand OK; desc **click** + **new tab** NOT stable |
| Sidebar related video | **PENDING ⏳** | No | Own-channel + unwatched today — wired, not live PASS |
| Ad skip | **VERIFIED ✅** | Yes — `smoke_ad_skip.py` 2026-06-09 | SKIP VERIFIED via CDP; JSON.stringify eval fix + 90s bailout guard + healing wire |
| 24/7 recycle loop | **PENDING ⏳** | Deferred | `recycle_engine.py` — user chose manual VideoShuffle |
| Dislike | **VERIFIED ✅** | Yes — `smoke_remaining_actions.py` | `2Vv-BfVoq4g` |
| Quality change (480p) | **VERIFIED ✅** | Yes — same script | UI_VERIFIED in logs |
| Scroll activity | **VERIFIED ✅** | Yes — idle_scroll x2 | `[ScrollActivity] completed` |
| Description collapse | **VERIFIED ✅** | Yes — after expand | `Description collapsed ✓` |
| Speed change (1.25x) | **VERIFIED ✅** | Yes — same script | early setup |

---

## 2. DO NOT TOUCH (locked actions)

User explicitly said **mat chhedna** for these. Only fix if user reports a new regression:

- `server_python/agent_manager.py` — `_do_like`, `_do_subscribe`, `_do_bell`, `_do_comment`, `_do_seek`, pause loop, `_do_volume_adjust`
- `server_python/behavior/youtube/desktop.py` — like, subscribe, bell, comment, seek, pause, play, volume, captions
- `server_python/behavior/youtube/player_controls.py`
- `server_python/behavior/youtube/play_pause_limiter.py`

---

## 3. Recently fixed (June 2026 session)

### Comment like ✅
- **Bug:** Video-time sync capped `elapsed` before late actions (70–95%) fired.
- **Fix:** Wall-clock `action_t` for scheduling; `_run_post_watch_actions()` after watch loop.
- **Files:** `agent_manager.py`, `desktop.like_comment_first()`, `worker_manager.py` (audit save in `finally`).
- **Test:** `python tests/smoke_final3.py --mode comment_like`
- **Proof:** `logs/action_audit_Profile-32ea_*.json` → `comment_like` pass=true

### Description expand ✅
- **Fix:** Scroll to description + 8-attempt poll for expand button / already expanded.
- **File:** `desktop.expand_description()`

### Description links ⏸ (COMING SOON)
- **What works:** Expand; fallback can open `hamstercombocard.com`; external visit + return.
- **What fails:** Click link inside YouTube `#expanded` DOM (lazy-load); reliable **new tab** not verified.
- **Server:** Forced OFF via `server_python/action_registry.py` + UI Coming Soon in `VideoShufflePage.tsx`.
- **Do NOT re-enable** until desc-click + new-tab flow is live PASS.

### Player ready (infra)
- **Fix:** `human_engine.wait_for_player()` — nudge click, softer fallback for watch page shell.
- **File:** `human_engine.py`, `agent_manager.py` (focus_player before wait)

### Action audit JSON
- **Purpose:** `honestTest: true` → truth table in `logs/action_audit_{profile}_{timestamp}.json`
- **Files:** `behavior/youtube/action_audit.py`, audit save in `worker_manager` + `agent_manager` finally

---

## 4. Key file map

| Area | Path |
|------|------|
| Watch loop + all actions | `server_python/agent_manager.py` |
| YouTube DOM clicks | `server_python/behavior/youtube/desktop.py` |
| Engagement dict builder | `server_python/worker_manager.py` → `_build_engagement_from_config()` |
| Action on/off registry | `server_python/action_registry.py` |
| Schedule API | `server_python/main.py` |
| Sidebar own-channel click | `server_python/sidebar_video.py` + `_do_related_video()` |
| Selectors (V2) | `MMB_YOUTUBE_SELECTORS_FINAL_V2.py` |
| VideoShuffle UI | `src/components/VideoShufflePage.tsx` |
| Engagement % UI | `src/components/EngagementPage.tsx` |
| Live smoke tests | `tests/smoke_final3.py`, `tests/smoke_phase2.py` |

---

## 5. Test videos (known good)

| Video ID | Title | Use for |
|----------|-------|---------|
| `2Vv-BfVoq4g` | Perfect (Ed Sheeran) | Comment like (has comments) |
| `uFy7lhTpVXI` | Best Credit Cards 2026 | Description expand; desc link has `hamstercombocard.com` |
| `615YoF6TKi8` | Idle Bank Tycoon USA | Sidebar related (USA INSURANCE channel) |

---

## 6. How to run live tests

```powershell
python tests/smoke_remaining_actions.py
python tests/smoke_final3.py --mode sidebar   # sidebar only
# desc_link disabled — do not run until coming-soon removed
```

---

## 7. Related video rules (when testing sidebar)

- Only sidebar videos from **user's own channels** (`ownChannelNames` from channels_data / VideoShuffle).
- Only if profile **has NOT watched** that video today (`watch_history` / `has_watched()`).
- Runs **after main video** completes.
- Needs `relatedVideoEnabled: true` — no dedicated UI toggle yet; pass in schedule JSON.

---

## 8. Description link rules (when re-enabled later)

1. User picks URL in UI (e.g. `https://hamstercombocard.com`).
2. Expand description → click **that** link (domain match).
3. Open in **new tab** (not same tab).
4. External site → visit ~120s with scroll/read.
5. YouTube link in desc → watch ~92% of that video.
6. Return to original video tab.

---

## 9. Next work (user priority order)

1. **Sidebar related video** — live test on `615YoF6TKi8`, clear watch history first.
2. **Ad skip** — later.
3. **24/7 recycle** — later.
4. **Description links** — only when user removes Coming Soon.

---

## 10. Registry API (server)

```python
from server_python.action_registry import (
    LOCKED_WORKING,
    COMING_SOON,
    sanitize_engagement,
    sanitize_config,
    is_action_enabled,
)

# descriptionLinks always forced False until removed from COMING_SOON
eng = sanitize_engagement(engagement_dict)
```

---

## 11. Audit log examples

- Comment like PASS: `logs/action_audit_Profile-32ea_20260608_105037.json`
- Desc link partial: `logs/action_audit_Profile-32ea_20260608_121433.json` (`direct_new_tab`, not `desc_click`)

---

*End of handoff — update this file when any action moves between LOCKED / VERIFIED / COMING_SOON / PENDING.*


