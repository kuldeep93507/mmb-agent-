# CHANGELOG V2 — YouTube Selectors & Dashboard Overhaul
**Date:** 5 June 2026

## Phase 1 — Selector Integration (Backend Core)

### Added
- `behavior/youtube/selectors.py` — 670 permanent selectors from `MMB_YOUTUBE_SELECTORS_FINAL_V2.py`
- `behavior/youtube/safe_actions.py` — `safe_click`, `safe_type`, `safe_wait`, `safe_eval_js`, `safe_click_key`
- `behavior/youtube/state.py` — `is_liked`, `is_disliked`, `is_subscribed`, `is_ad_playing`, `get_*` functions
- `behavior/youtube/desktop.py` — Desktop action wrappers (play, like, subscribe, search, comments, etc.)
- `behavior/youtube/mobile.py` — Mobile web action wrappers
- `behavior/youtube/player_focus.py` — Player scroll, controls reveal, unmute
- `behavior/youtube/entry_flow.py` — Navigate, consent, warm entry sequence
- `actions/related_video.py` — Sidebar & endscreen video clicks
- `logs/actions.jsonl` — JSON-line action logging

### Changed
- `server_python/yt_selectors.py` — Replaced manual map with V2 auto-bridge (228 keys)
- `yt_actions.py` — Like/dislike/subscribe/ad/bell use V2 fallback chains + state detection
- `server_python/ad_handler.py` — Uses `DESKTOP['ad_skip_button']` + `state.is_ad_playing()`

### Unchanged (Compatible)
- `server_python/resolver.py` — Reads bridge SELECTOR_MAP automatically
- `server_python/human_engine.py` — Compatible via resolver
- CLI entry points (`start_server.py`, `full_test.py`) — No breaking changes

---

## Phase 2 — Audit & Tests

### Added
- `AUDIT_REPORT_V2.md` — File-by-file audit with fixes applied
- `tests/test_selectors_v2.py` — V2 stability tests (no hashed classes, no nth-child)
- `tests/test_safe_actions.py` — Fallback chain unit tests
- `tests/test_state.py` — State detection mock tests
- `tests/test_yt_selectors_bridge.py` — Legacy alias compatibility tests
- `pytest` + `pytest-asyncio` in `server_python/requirements.txt`

### Test Results
```
23 passed in ~7s
python -m pytest tests/ -v
```

---

## Phase 3 — Dashboard Foundation

### Added
- `dashboard/app.py` — Flask control panel with V2 API endpoints
- `dashboard/templates/base.html` — Tailwind + Alpine.js + Lucide sidebar layout
- `dashboard/templates/index.html` — Live stats, activity feed (HTMX 2s), profile health

### API Endpoints (New)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats/live` | Live dashboard metrics |
| GET | `/api/profiles` | Profile list with health |
| POST | `/api/profiles/{id}/test` | Test launch profile |
| GET | `/api/proxies` | Proxy pool status |
| POST | `/api/jobs` | Create scheduled job |
| GET | `/api/logs/tail?n=100&filter=` | Tail action logs |
| POST | `/api/bot/start` | Start bot run |
| POST | `/api/bot/stop` | Emergency stop |
| GET | `/dashboard` | V2 control panel UI |

### Note
React/Electron UI (`src/components/`) remains the primary dashboard. Flask `/dashboard` is a supplementary control panel.

---

## Migration Guide

```python
# Old way (hardcoded)
await tab.select('button[aria-label="like this video"]')

# New way (V2 fallback chain)
from behavior.youtube.safe_actions import safe_click
from behavior.youtube.selectors import DESKTOP
await safe_click(tab, DESKTOP['like_button'], action_name='LIKE')

# State check before action
from behavior.youtube.state import is_liked
if not await is_liked(tab):
    await safe_click(tab, DESKTOP['like_button'], action_name='LIKE')
```

---

## V2.1 Update — Anti-Detection + Full Dashboard Pages

### Added
- `behavior/youtube/anti_detect.py` — Rules A-K: Bezier human_click, human_type with typos, page_is_safe, human_delay, action shuffle, daily caps
- `behavior/youtube/human_engine.py` — V2 wrapper over server_python.human_engine
- `behavior/youtube/notification_path.py` — V2 bell panel opener
- `dashboard/static/app.css` + `app.js` — toasts, localStorage drafts, Ctrl+K search
- 10 dashboard pages: `/dashboard`, `/dashboard/videos`, `/profiles`, `/proxies`, `/engagement`, `/scheduler`, `/shuffle`, `/analytics`, `/logs`, `/settings`
- `tests/test_anti_detect.py`, `tests/test_dashboard_api.py`, `tests/test_desktop_actions.py`

### Changed
- `safe_click()` — default `human=True` (Bezier CDP click), `check_page_safe=True` (Rule K)
- `safe_type()` — gaussian delays + typo simulation (Rule B)
- `desktop.py` — 30+ actions: mute, join, share, download, chapters, bell levels, quality, speed, engagement_bundle

### Test Results (V2.1)
```
36 passed in 2.20s
```

---

## BUGFIX Sprint — Production Issues (Jun 2026)

### BUG #3 — Play/Pause Spam (DETECTION RISK) ✅

**Problem:** `pauseProbability > 0` was treated as "always pause once" with 12–28s holds via `k` key toggles — unrealistic bot signal.

**Fix:**
- Added `behavior/youtube/play_pause_limiter.py` — `PlayPauseLimiter` caps 0–2 pauses/session (~50% sessions = zero), min 30s gap
- Watch loop now rolls `pauseProbability` per tick (capped 8%) instead of forcing pause whenever prob > 0
- Pause hold shortened to 2–6s (realistic); explicit `pauseHoldSec` still honored once
- Uses `yt_desktop.pause()` / `yt_desktop.play()` instead of raw `k` key spam

**Files:** `server_python/agent_manager.py`, `behavior/youtube/play_pause_limiter.py`, `tests/test_play_pause_limiter.py`

### BUG #4 — No Scroll Activity During Video ✅

**Problem:** Watch loop had only tiny ±120px jitter — no description/comment/chapter reading behavior.

**Fix:**
- Added `behavior/youtube/scroll_activity.py` — `human_scroll_activity_plan()` + `ScrollActivityPlanner`
- 4 modes: read_description (30%), read_comments (40%), check_chapters (20%), idle_scroll (60%)
- Smooth scroll, 2–5s reading delays, hover comments/hashtags, always `scroll_back_to_player()`
- Integrated into `_human_watch_loop`; toggle via `scrollActivity` / `scroll` engagement flag

**Files:** `behavior/youtube/scroll_activity.py`, `server_python/agent_manager.py`, `tests/test_scroll_activity.py`, `BUGFIX_REPORT.md`

### BUG #1 — Quality Change Timing ✅

**Fix:** 3–8s player settle → quality in first ~15s with `[QUALITY] @ Xs` log. Never at watch end.

### BUG #2 — Quality Change Unreliable ✅

**Fix:** New `behavior/youtube/quality.py` — focus, reveal controls, gear fallback, menu verify, label-based quality pick, 2 retries, full diagnostics.

### BUG #5 — VideoShuffle UI Controls ✅

**Fix:** Speed pills, captions toggle, traffic source cards, 7 engagement toggles (replaced pause slider). Wired to backend via schedule payload + `main.py`.

---

## Remaining (Future Sprints)
- WebSocket `/ws/activity` via Flask-SocketIO
- Full 10-page dashboard (Video Targets, Scheduler calendar, Analytics charts)
- `agent_manager.py` autoplay inline JS → safe_click refactor
- APScheduler + SQLAlchemy persistence layer
