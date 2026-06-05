# STEP 1 — `agent_manager.py` V2 Refactor

## Summary

Refactored `server_python/agent_manager.py` to delegate all browser DOM actions to the V2 `behavior/youtube/` package. Removed ~350 lines of inline JS, hardcoded selectors, CDP probe helpers, and raw `tab.evaluate()` calls.

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| **LOC** | 1,611 | 1,258 | **−353 (−22%)** |
| `time.sleep` | 0 (already asyncio) | 0 | — |
| `.click()` in file | 12+ inline JS | **0** | ✅ |
| `document.querySelector` | 40+ inline | **0** | ✅ |
| `tab.evaluate` | 25+ raw calls | **0** (via `_js` → `safe_eval_js`) | ✅ |
| Hardcoded selector tuples | `_LIKE_SELECTORS`, `_SUBSCRIBE_SELECTORS` | **removed** | ✅ |
| New pytest tests | — | **10** in `tests/test_agent_manager.py` | ✅ |

## Acceptance Grep

```bash
grep -rn "time.sleep\|\.click()\|document.querySelector" server_python/agent_manager.py
# → ZERO matches (only comment text mentions tab.evaluate)
```

---

## Change Log (Before → After)

### 1. New infrastructure helpers

**Before:** Every method called `tab.evaluate(...)` directly with inline JS.

**After:** Two thin wrappers on `YouTubeAgent`:

```python
async def _js(self, code, *, action_name="JS", wrap=True):
    return await safe_eval_js(self.tab, code, action_name=action_name, wrap=wrap, log_result=False)

async def _human_pause(self, lo, hi):
    await asyncio.sleep(self._rng.uniform(lo, hi))
```

**Why:** Centralizes IIFE wrapping, action logging, and random delays (Rule C).

---

### 2. `_dismiss_consent`

| Before | After |
|--------|-------|
| 30-line inline JS with `document.querySelectorAll` + `btn.click()` | `accept_consent_if_present(self.tab)` from `behavior/youtube/entry_flow.py` |

---

### 3. `_get_duration`

| Before | After |
|--------|-------|
| 10-attempt poll loop with inline `document.querySelector('video')` | `get_video_duration_when_ready(self.tab)` from `behavior/youtube/state.py` |

---

### 4. `_apply_video_settings`

| Before | After |
|--------|-------|
| 35-line JS: `setAutonavState`, localStorage, `btn.click()` on autoplay toggle | `yt_desktop.disable_autoplay(self.tab)` — uses `JS_API` + `DESKTOP["autoplay_toggle_button"]` |

---

### 5. `_focus_player`

| Before | After |
|--------|-------|
| Inline JS `p.click()` on `#movie_player` | `focus_player(self.tab)` from `behavior/youtube/player_focus.py` |

---

### 6. `_do_like` (+ removed `_probe_button_rect`, `_LIKE_SELECTORS`)

| Before | After |
|--------|-------|
| CDP probe + 8 hardcoded selectors + inline `btn.click()` | `is_liked()` guard → `yt_desktop.like(tab, want=True)` with `safe_click` + state verify |

**State check:** Skips action if already liked (no double-like).

---

### 7. `_do_subscribe` (+ removed `_SUBSCRIBE_SELECTORS`)

| Before | After |
|--------|-------|
| CDP probe + 4 hardcoded selectors + inline `btn.click()` | `is_subscribed()` guard → `yt_desktop.subscribe(tab, want=True)` |

---

### 8. `_do_comment`

| Before | After |
|--------|-------|
| Inline scroll JS + 4 input selectors + `send_keys_human` bulk + submit `btn.click()` | `yt_desktop.scroll_to_comments()` + `yt_desktop.post_comment()` (`safe_type` char-by-char) |

---

### 9. `_do_dislike`

| Before | After |
|--------|-------|
| 5 hardcoded selectors + inline `btn.click()` | `is_disliked()` guard → `yt_desktop.dislike(tab, want=True)` |

---

### 10. `_do_bell`

| Before | After |
|--------|-------|
| 4 bell selectors + menu `items[i].click()` for "All" | `yt_desktop.toggle_bell()` + `yt_desktop.set_bell_level(tab, "All")` |

---

### 11. `_do_quality_change`

| Before | After |
|--------|-------|
| Settings gear `btn.click()` + `.ytp-menuitem` loops (3 evaluate blocks) | `yt_desktop.set_quality(tab, want)` with quality label mapping preserved |

---

### 12. `_do_volume_adjust` (+ removed `_read_yt_volume`)

| Before | After |
|--------|-------|
| Inline `#movie_player.setVolume` + `document.querySelector('video')` | `yt_desktop.set_volume()` + `get_volume_percent()` verify |

---

### 13. `_do_like_comment`

| Before | After |
|--------|-------|
| 3 selector chains + `btn.click()` loop | `yt_desktop.like_comment_first(tab)` via `DESKTOP["comment_like_button"]` |

---

### 14. `_do_expand_description`

| Before | After |
|--------|-------|
| 4 hardcoded expand selectors + `btn.click()` | `yt_desktop.expand_description(tab)` via `DESKTOP["description_more_button"]` |

---

### 15. `_do_click_description_link`

| Before | After |
|--------|-------|
| Inline `desc.querySelectorAll('a[href]')` + `links[idx].click()` | `yt_desktop.click_description_link(tab, rng=self._rng)` |

---

### 16. `_scroll_to_video_top`

| Before | After |
|--------|-------|
| `tab.evaluate("window.scrollTo(...)")` | `yt_desktop.scroll_to_top(self.tab)` |

---

### 17. `_scroll`

| Before | After |
|--------|-------|
| `tab.evaluate(f"window.scrollBy(0, {step})")` per step | `self._js(f"window.scrollBy(0, {step})", action_name="SCROLL", wrap=False)` |

---

### 18. `_move_mouse`

| Before | After |
|--------|-------|
| CDP wander + `tab.evaluate(MouseEvent dispatch)` fallback | CDP wander + `self._js(MouseEvent dispatch)` fallback |

---

## Unchanged (callers safe)

Public API preserved — no breaking changes:

- `YouTubeAgent.connect_cdp`, `watch_video`, `watch_video_direct`, `go_to_youtube_home`, `close`
- `AgentManager` orchestrator class and all its methods
- Callers in `main.py`, `orchestrator.py`, `recycle_engine.py` unchanged

---

## New Tests (`tests/test_agent_manager.py`)

| Test | Verifies |
|------|----------|
| `test_do_like_skips_when_already_liked` | State guard — no double-like |
| `test_do_like_delegates_to_desktop` | V2 `yt_desktop.like` called |
| `test_do_subscribe_skips_when_subscribed` | State guard |
| `test_do_dislike_skips_when_already_disliked` | State guard |
| `test_get_duration_delegates_to_state` | V2 duration polling |
| `test_apply_video_settings_delegates_disable_autoplay` | V2 autoplay lock |
| `test_do_comment_delegates_scroll_and_post` | V2 comment flow |
| `test_dismiss_consent_delegates_entry_flow` | V2 consent |
| `test_do_quality_change_maps_1080p` | Quality label mapping preserved |
| `test_scroll_uses_js_wrapper` | No raw `tab.evaluate` |

---

## Run Tests

```bash
python -m pytest tests/ -v --tb=short
```

Expected: **46 passed** (36 existing + 10 new).
