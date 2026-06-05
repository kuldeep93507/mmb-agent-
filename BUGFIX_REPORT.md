# BUGFIX Sprint Report

Production bugs found during live testing on 2 profiles. Fixes applied in strict order; each bug STOPs for approval before next.

---

## BUG #3 — Play/Pause Spam ✅ FIXED

### Description
Bot toggled play/pause excessively during a single video — strong bot detection signal. Real humans pause 0–2 times per ~10 min video.

### Root Cause
`pauseProbability > 0` (default 12%) was treated as **always pause once**, not a random roll. Every session with `pauseProbability: 0.12` forced one pause of **12–28 seconds** via double `_tap_key("k")`.

### Files Changed
| File | Change |
|------|--------|
| `behavior/youtube/play_pause_limiter.py` | **NEW** — `PlayPauseLimiter` (0–2 pauses, 30s min gap, ~50% zero-pause sessions) |
| `server_python/agent_manager.py` | Per-tick probabilistic pause + V2 `pause()`/`play()` |
| `tests/test_play_pause_limiter.py` | 5 unit tests |
| `CHANGELOG_V2.md` | BUG #3 entry |

### Before / After

**Before:**
```python
_pause_wanted = _pause_hold > 0 or engagement.get("pauseProbability", 0) > 0
will_pause = elapsed >= pause_at and "pause" not in engagement_done and _pause_wanted
await self._tap_key("k")  # pause
await asyncio.sleep(hold)  # 12-28s
await self._tap_key("k")  # resume
```

**After:**
```python
pause_limiter = PlayPauseLimiter(rng=rng)  # max 0-2, weighted 50/35/15
if pause_limiter.can_pause(elapsed) and rng.random() < _pause_prob:
    await yt_desktop.pause(self.tab)
    pause_limiter.record_pause(elapsed)
    await asyncio.sleep(rng.uniform(2.0, 6.0))
    await yt_desktop.play(self.tab)
```

### New Tests
- `test_zero_max_never_allows_pause`
- `test_max_pauses_enforced`
- `test_min_gap_between_pauses`
- `test_play_pause_limited_per_session`
- `test_half_sessions_have_zero_pauses_budget`

### How to Verify
1. Run engagement on a 5+ min video with default settings
2. Check logs for `[PauseLimiter] max=0` (~50% sessions) or `[1/1]` / `[1/2]` pause counts
3. Confirm no rapid `k` key spam; holds are 2–6s unless `pauseHoldSec` explicitly set

---

## BUG #4 — No Scroll Activity During Video ✅ FIXED

### Description
Bot opened video, watched passively, left. No description reading, comment browsing, or natural scroll — unrealistic vs real human behavior.

### Root Cause
Watch loop only had tiny random `±120px` micro-scroll (`behavior.scroll_prob` ~22%). No planned activities to read description, browse comments, or hover chapters.

### Files Changed
| File | Change |
|------|--------|
| `behavior/youtube/scroll_activity.py` | **NEW** — planner + 4 activity modes |
| `server_python/agent_manager.py` | `ScrollActivityPlanner` integrated in `_human_watch_loop` |
| `tests/test_scroll_activity.py` | 8 unit tests (1 skipped if seed lacks chapters) |
| `CHANGELOG_V2.md` | BUG #4 entry |

### Activity Modes

| Mode | Chance | Timing | Behavior |
|------|--------|--------|----------|
| `read_description` | 30% | 15–45s | Expand via `DESKTOP['description_more_button']`, read 3–6s, optional hashtag hover (15%), collapse (40%), scroll back |
| `read_comments` | 40% | 60–180s | Smooth scroll to comments, 2–5 read scrolls, hover top thread, scroll back |
| `check_chapters` | 20% | 20–60s | Only if chapters exist; scroll to chapter cards, hover, scroll back |
| `idle_scroll` | 60% (fallback) | 40–120s | 2–4 small ±150px smooth scrolls, scroll back |

**Constraints:** 1–3 activities per session, sorted by time, always returns to player.

### Before / After

**Before:**
```python
# Only micro jitter when no engagement tick
if rng.random() < behavior.scroll_prob:
    await self._scroll(rng.randint(-60, 120))
```

**After:**
```python
scroll_planner = ScrollActivityPlanner(watch_secs, rng, enabled=scrollActivity)
# Each tick:
if await scroll_planner.tick_and_run(self.tab, elapsed, guardian):
    # read_description / read_comments / check_chapters / idle_scroll
    # always ends with scroll_back_to_player()
```

### New Tests
- `test_human_scroll_activity_plan_always_1_to_3`
- `test_human_scroll_activity_triggers`
- `test_planner_tick_runs_at_most_one_per_call`
- `test_scroll_back_to_player_uses_safe_eval`
- `test_small_idle_scroll_smooth_steps`
- `test_planner_respects_activity_time_windows`
- (+ disabled/short-video edge cases)

### How to Verify
1. Run watch session on any video 3+ min
2. Log should show: `[ScrollActivity] planned 2: read_description@32s, idle_scroll@78s`
3. During run: `[ScrollActivity] read_description @ 35s (planned 32s)`
4. After session: `[ScrollActivity] completed: ['read_description', 'idle_scroll']`
5. Player visible again after each activity (scroll back)

---

## BUG #1 — Quality Change at END (Wrong Timing) ✅ FIXED

### Description
Quality change had no settle period and could appear late relative to user expectation. Full playback should use target quality from the start.

### Root Cause
Quality ran immediately after autoplay lock with only 1–2s delay, but **after** long ad-skip waits with no session timestamp. No enforced "early window" logging.

### Fix
- Added `_watch_session_t0` at player-ready
- **3–8s settle** period before early setup actions
- Quality runs **before** volume + watch loop (never at end)
- Log: `[QUALITY] @ 9.2s → 360p OK ✓ (target <15s)`
- Respects `qualityChange` / `qualityChangeEnabled` toggle from UI

### Files
`server_python/agent_manager.py`, `tests/test_quality.py` (`test_quality_change_happens_early`)

---

## BUG #2 — Quality Change FAILS on Some Profiles ✅ FIXED

### Description
Quality worked on 1 profile but failed on 2 others — fragile menu clicks, no diagnostics.

### Root Cause
`set_quality()` used single-pass `.click()` on `.ytp-menuitem` with no player focus, no menu verify, no retry, no logging.

### Fix — `behavior/youtube/quality.py`
- `focus_player()` + `reveal_controls()` before gear click
- `safe_click(DESKTOP['settings_gear_button'])` with fallback chain
- Verify `.ytp-settings-menu` opened
- Click Quality by **label text** (not position)
- List available qualities in log
- Click target via `MouseEvent` dispatch (not raw `.click()`)
- 2-attempt retry loop
- Step logs: `[QUALITY][prof] Settings button clicked: True` etc.

### Files
`behavior/youtube/quality.py`, `behavior/youtube/desktop.py`, `tests/test_quality.py` (6 tests)

---

## BUG #5 — VideoShuffle Missing UI Controls ✅ FIXED

### Description
Missing speed, captions, traffic source, and per-action toggles (user wanted ON/OFF not sliders).

### Fix — `VideoShufflePage.tsx`
| Control | Added |
|---------|-------|
| Playback speed | 6 pill buttons (0.75x–2x) |
| Captions | iOS-style toggle |
| Traffic source | 3 selectable cards (direct/search/suggested) |
| Engagement | 7 toggles (like, subscribe, bell, comment, scroll, quality, captions) |
| Pause slider | **Removed** (replaced by backend PlayPauseLimiter) |

Settings persist in `mmb_shuffle_settings` localStorage and flow to schedule payload + `main.py` config.

### Files
`src/components/VideoShufflePage.tsx`, `server_python/main.py`, `dashboard/templates/index.html` (basic mirror)

---

## Sprint Status

| Bug | Status |
|-----|--------|
| #3 Play/Pause spam | ✅ Fixed |
| #4 No scroll activity | ✅ Fixed |
| #1 Quality timing | ✅ Fixed |
| #2 Quality unreliable | ✅ Fixed |
| #5 VideoShuffle UI | ✅ Fixed |
