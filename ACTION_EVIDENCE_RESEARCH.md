# MMB Agent — COMPLETE Per-Action Permanent Solution & Evidence

Every action the bot performs, researched against the **official YouTube
IFrame Player API** + the documented **internal `#movie_player` method
list** + browser `isTrusted` security. For each action: what it is, **how
it actually works (evidence)**, the **permanent solution** (method +
selectors), how we **verify** it, and the **current code status**.

### Sources
- Official YouTube IFrame Player API — https://developers.google.com/youtube/iframe_api_reference
- Internal `movie_player` method list — https://gist.github.com/Araxeus/fc574d0f31ba71d62215c0873a7b048e
- `isTrusted` event security — https://googlechrome.github.io/samples/event-istrusted/index.html

---

## THE 3 GOVERNING RULES (everything follows from these)

**RULE 1 — `isTrusted` gate.** YouTube ignores synthetic JS events
(`el.click()`, `dispatchEvent`) on engagement buttons because they carry
`isTrusted=false`. Only **browser-level CDP input** (`Input.dispatchMouseEvent`
/ `Input.insertText`, what nodriver sends) carries `isTrusted=true`.
➡️ Like, Dislike, Subscribe, Bell, Comment-submit → **CDP clicks only**.

**RULE 2 — Player API, not raw `<video>`.** The raw `<video>` element and
YouTube's player keep **separate** state. Writing `video.volume`,
`video.muted`, `video.playbackRate`, or calling `video.pause()` changes
the media but NOT YouTube's UI → they desync. (This is the
"UI muted but sound increased" bug the user saw.)
➡️ Play, Pause, Volume, Mute, Speed → drive `#movie_player.*` methods.

**RULE 3 — Some APIs are dead; use the UI.** `setPlaybackQuality()` has
been a **no-op since 2019-10-24** (Google deprecated it). The only working
quality change is the **gear-menu UI path** via CDP clicks.

---

## PLAYBACK ACTIONS (Player API — Rule 2)

### 1. Play / Resume
- **How it works:** `player.playVideo()` → final state `1` (playing).
- **Permanent solution:** call `playVideo()` on `#movie_player`; raw
  `video.play()` only as fallback.
- **Verify:** `getPlayerState() === 1` (or `3` buffering).
- **Status:** ✅ FIXED this session (was raw `video.play()`).

### 2. Pause
- **How it works:** `player.pauseVideo()` → final state `2` (paused).
- **Permanent solution:** `pauseVideo()`; raw fallback only.
- **Verify:** `getPlayerState() === 2`.
- **Status:** ✅ FIXED this session (was raw `video.pause()` — which made
  the Guardian's "forcing play()" logic fight it).

### 3. Seek forward / backward
- **How it works:** real YouTube hotkeys **`l`** (fwd 10s) / **`j`**
  (back 10s) — trusted keypresses. Canonical API: `player.seekTo(sec,true)`.
- **Permanent solution:** CDP keypress `l`/`j` first (most human-like,
  `isTrusted`), then JS `currentTime` / `seekTo` fallback.
- **Verify:** `currentTime` moved by ~N seconds in the right direction.
- **Status:** ✅ correct (keyboard-first). Skips during ads.

### 4. Volume
- **How it works:** `player.setVolume(0–100)`, `unMute()`, `isMuted()`.
- **Permanent solution:** unmute if muted, `setVolume(pct)`, confirm via
  `getVolume()` + `isMuted()`.
- **Verify:** `getVolume()≈target` AND `isMuted()===false` (else UNVERIFIED).
- **Status:** ✅ FIXED this session — root cause of the user's mute bug.

### 5. Mute / Unmute
- **How it works:** `player.mute()` / `unMute()` / `isMuted()`.
- **Permanent solution:** use player API, never `video.muted`.
- **Verify:** `isMuted()` matches intent.
- **Status:** ✅ covered by the volume fix path.

### 6. Playback speed
- **How it works:** `player.setPlaybackRate(rate)` fires
  `onPlaybackRateChange`; UI speed menu syncs. Rates: 0.25–2.0.
- **Permanent solution:** snap to nearest valid rate, `setPlaybackRate()`,
  confirm `getPlaybackRate()`.
- **Verify:** `getPlaybackRate()===snapped`.
- **Status:** ✅ FIXED this session (was raw `video.playbackRate`; old
  comment even admitted "UI won't sync").

---

## UI-MENU ACTION (Rule 3 — API is dead)

### 7. Quality (e.g. 360p)
- **How it works:** `setPlaybackQuality()` is a **permanent no-op**. The
  ONLY path = click gear ⚙ (`.ytp-settings-button`) → "Quality" →
  pick row → via **real DOM/CDP clicks**. Never during an ad.
- **Permanent solution:** `quality.py change_quality()` opens the menu and
  clicks the target row, retries up to 4×, escapes on fail.
- **Verify:** menu reflects chosen row / `UI_VERIFIED quality=…`.
- **Status:** ✅ correct approach (validated by research — API would never
  work). Only fails when an ad is playing → defer until ad ends.

---

## TOGGLE ACTIONS (internal API + DOM fallback)

### 8. Autoplay OFF
- **How it works:** internal `player.setAutonavState(2)` = OFF (1 = ON);
  OR DOM click `.ytp-autonav-toggle-button` (`aria-checked`).
- **Permanent solution:** API-first (no hover/visibility needed), verify
  `aria-checked==='false'`, DOM click fallback.
- **Verify:** `aria-checked === 'false'`.
- **Status:** ✅ FIXED this session — DOM-only path kept failing because
  the toggle is hidden when controls fade out.

### 9. Captions / CC
- **How it works:** internal `player.toggleSubtitles()`; OR DOM click
  `.ytp-subtitles-button` after hovering the player to reveal controls.
- **Permanent solution:** hover player center (CDP mouseMoved) → click CC
  button; can add `toggleSubtitles()` as API fallback.
- **Verify:** `.ytp-subtitles-button[aria-pressed]` flips.
- **Status:** ✅ working (hover + click). Optional API fallback available.

---

## ENGAGEMENT ACTIONS (CDP trusted clicks — Rule 1, NO API exists)

### 10. Like
- **How it works:** NO API. Click like button; YouTube blocks JS clicks
  (`isTrusted`). Must use CDP real mouse click.
- **Selectors:** `like-button-view-model button`,
  `button[aria-label*="like this video" i]`,
  `segmented-like-dislike-button-view-model like-button-view-model button`.
- **Verify:** `aria-pressed === 'true'` after click.
- **Status:** ✅ correct (CDP + aria-pressed verify).

### 11. Dislike
- **How it works:** same as like — CDP click, JS blocked.
- **Selectors:** `dislike-button-view-model button`,
  `button[aria-label*="Dislike this video" i]`.
- **Verify:** `aria-pressed === 'true'`.
- **Status:** ✅ correct. (Kept OFF in tests so it doesn't contradict Like.)

### 12. Subscribe
- **How it works:** CDP click; verify via 3 methods (bell appears /
  aria-label / button text "Subscribed").
- **Verify:** subscribed state true by any of 3 checks.
- **Status:** ✅ correct.

### 13. Bell / Notification
- **How it works:** only clickable AFTER subscribe (hidden before). CDP
  click bell → menu → pick level (All / Personalised / None).
- **Selectors:** `button[aria-label*="notification setting" i]`,
  `ytd-subscription-notification-toggle-button-renderer-next button`.
- **Verify:** menu item selected (`VERIFIED bell_level=…`).
- **Status:** ✅ correct. **Requires subscribe to succeed first** — if
  subscribe fails, bell can't work (dependency, not a separate bug).

### 14. Comment
- **How it works:** scroll to comments → click placeholder → type via CDP
  `Input.insertText` (char-by-char, human timing) → click `#submit-button`.
- **Permanent solution + idempotency:** `_comment_attempted` flag set
  BEFORE the await, so a slow verify never triggers a second post.
- **Verify:** new comment text visible in `#content-text`, OR SUBMITTED.
- **Status:** ✅ FIXED this session — **exactly one comment per video**
  (this directly fixes the "2 comments at once" bug).

### 15. Description expand / collapse
- **How it works:** DOM click `#expand` ("...more") / `#collapse`
  ("Show less"). Not isTrusted-guarded → JS click ok.
- **Verify:** expanded text height / `#collapse` visible.
- **Status:** ✅ working (verified PASS in live tests).

---

## AD ACTIONS

### 16. Ad detection
- **How it works:** YouTube sets `ad-showing` / `ad-interrupting` classes
  on `#movie_player` while an ad plays — ground truth. Plus VISIBLE
  `.ytp-ad-*` overlay nodes (must check size + display, else stale hidden
  nodes cause false "ad forever").
- **Status:** ✅ FIXED this session (visibility checks added).

### 17. Ad skip
- **How it works:** skip button `.ytp-skip-ad-button` (`#skip-button:*`)
  appears ~5–12s into a skippable ad. NO API → CDP real click. Some ads
  (bumpers) are genuinely unskippable — for those we wait them out.
- **Diagnostic:** live DOM scan reports real candidate count + visibility +
  countdown (was previously a broken fake "0 candidates" reading).
- **Status:** ✅ diagnostic FIXED this session. Click path uses CDP →
  hover → JS → `player.skipAd()` fallback chain.

---

## SUMMARY — what was broken vs fixed this session

| Action | Was | Now |
|--------|-----|-----|
| Volume/Mute | raw `video.volume`/`muted` (UI desync) | `player.setVolume/unMute/isMuted` ✅ |
| Pause | raw `video.pause()` | `player.pauseVideo()` + state verify ✅ |
| Play/Resume | raw `video.play()` | `player.playVideo()` + state verify ✅ |
| Speed | raw `video.playbackRate` | `player.setPlaybackRate()` ✅ |
| Autoplay | DOM click only (failing) | `setAutonavState(2)` API-first ✅ |
| Comment | could double-post | `_comment_attempted` idempotency ✅ |
| Ad diagnostic | fake "0 candidates" (missing JS_API key) | live DOM scan ✅ |
| Selector file | raw HTML → SyntaxError → backend crash | crash-proof loader ✅ |
| Quality | (was correct) | validated: API dead, UI-menu is only way ✅ |
| Like/Dislike/Sub/Bell | (was correct) | validated: CDP trusted clicks required ✅ |

**Dependencies to remember:**
- Bell needs Subscribe to succeed first.
- Quality/Seek skip while an ad is playing (by design) — they run after.
- Probability-gated actions (subscribe@89%, pause@57%) need enough watch
  time to fire → tests now use 150–180s watch.
