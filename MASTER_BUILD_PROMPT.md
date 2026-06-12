# MASTER BUILD PROMPT — MMB Agent 24/7

> Copy this whole file and give it to any AI/developer. It specifies the ENTIRE
> project — every feature, logic, and small detail — so it can be rebuilt from
> scratch. Read top to bottom before writing code.

---

## 0. WHAT YOU ARE BUILDING

A desktop **web app** called **MMB Agent 24/7** — a YouTube growth-automation
control panel. One operator runs many anti-detect browser profiles (1–50+) that
watch their own YouTube videos and perform human-like engagement (like,
subscribe, comment, etc.) to grow their channels — while staying undetected.

**It is NOT an ad blocker and NOT mobile.** It drives real browser profiles via
CDP, behaving like real human viewers.

---

## 1. TECH STACK (use exactly this)

- **Frontend:** React 19 + TypeScript + Vite + TailwindCSS 4 + lucide-react
  (icons) + recharts (charts). Desktop web app (NOT Electron).
- **Backend:** Python Flask, single server on port 3100. Auth via `x-api-key`
  header (default `mmb-local-dev-2025`, overridable per machine).
- **Browser control:** anti-detect providers **MoreLogin** / **Multilogin**
  (each profile = a separate fingerprinted browser). Automation via **nodriver**
  + **CDP** (Chrome DevTools Protocol).
- **AI:** Anthropic Claude (tiered: Haiku/Sonnet/Opus) via `anthropic` SDK.
- **Proxy:** SmartProxy residential per profile.
- Design tokens via CSS variables (`--mmb-*`) in index.css; aurora gradient
  theme, glass cards, dark+light.

---

## 2. ARCHITECTURE

- **Backend = agent.** Controls THIS machine's profiles. Exposes a REST API.
- **Frontend = dashboard.** React app talking to the backend.
- **Browser profiles** opened via provider; nodriver attaches over CDP; all
  YouTube actions run as CDP/JS inside that tab.
- **Fleet mode (multi-laptop):** each laptop runs the backend (agent); one
  "controller" registers other laptops (Tailscale/LAN IP + API key) and fans
  out commands in parallel. (See section 9.)

---

## 3. GOLDEN RULES (never violate)

1. **Never break working code.** Locked YouTube actions stay untouched unless a
   regression is reported.
2. **All real browser events must be `isTrusted`** — YouTube ignores synthetic
   JS clicks on engagement buttons. Use CDP `Input.dispatchMouseEvent` /
   `Input.dispatchKeyEvent` (browser-level, isTrusted=true). Same for scrolling
   (CDP wheel events, NOT `window.scrollBy`).
3. **Player actions use YouTube's player API, not raw `<video>`** — raw element
   and player keep separate state and desync (the "UI muted but sound on" bug).
4. **Critical actions = action + independent verification** (e.g. comment posted
   AND visible in DOM; like AND aria-pressed=true).
5. **Quality cannot be set via API** — `setPlaybackQuality()` is a no-op since
   2019; only the gear-menu UI click works.
6. **Ad-skip: NO fast-forward (currentTime=duration) and NO vision/coordinates**
   — fast-forward denies ad revenue + is a bot giveaway; vision isn't reliable.
   Skip = wait human delay → click the real skip button via CDP. If the selector
   breaks, the Self-Healing page supplies a new one (no code change).
7. **AI features must have on/off toggles** (save API credits).
8. **Per-profile uniqueness via SHA256 seeding** (section 7) — no two profiles
   behave identically; no global pattern.

---

## 4. YOUTUBE ACTIONS (engine) — each with exact method

Build `ad_skip_engine.py` + `behavior/youtube/desktop.py` + `agent_manager.py`.

| Action | Exact method |
|--------|--------------|
| Play / Resume | `player.playVideo()`; verify `getPlayerState()===1` |
| Pause | `player.pauseVideo()`; verify state `2` |
| Seek | CDP keypress `l` (fwd) / `j` (back) — real hotkeys; verify currentTime moved |
| Volume | `player.setVolume(0-100)` + `unMute()` + `isMuted()` — NEVER `video.volume` |
| Mute | `player.mute()/unMute()/isMuted()` |
| Speed | `player.setPlaybackRate(rate)` (snap to 0.25..2.0) |
| Quality | UI: click gear `.ytp-settings-button` → Quality → row (NO API) |
| Autoplay off | `player.setAutonavState(2)` API-first, else click `.ytp-autonav-toggle-button` |
| Captions/CC | hover player → click `.ytp-subtitles-button` (or `player.toggleSubtitles()`) |
| Like / Dislike | CDP real click on `like/dislike-button-view-model button`; verify `aria-pressed` |
| Subscribe | CDP real click; verify via bell appears / aria-label / "Subscribed" text |
| Bell | only after subscribe; CDP click → menu → pick level |
| Comment | scroll to comments → click placeholder → type via CDP `Input.insertText` (char-by-char, human timing) → click `#submit-button`; verify text visible; **idempotency flag so only ONE comment per video** |
| Description | click `#expand` ("...more") / `#collapse` |
| Ad detection | `#movie_player` has class `ad-showing`/`ad-interrupting` (+ require visible ad overlay node, not stale hidden ones) |
| Ad skip | wait human delay (~5–12s, skip button appears ~12s) → `find_skip_target()` via selectors → CDP real click → JS click fallback → `player.skipAd()` last; verify ad cleared |

**CRITICAL `_eval` rule:** nodriver `return_by_value=True` silently returns
`None` for JS OBJECT results. ALWAYS wrap JS in `JSON.stringify((...))` and
`json.loads()` on the Python side, or object returns (like the skip-button
coords) come back as None and nothing works.

---

## 5. SELECTORS + SELF-HEALING

- Selectors live in `MMB_YOUTUBE_SELECTORS_FINAL_V2.py` (DESKTOP dict of tuples
  per action key). `behavior/youtube/selectors.py` loads it in a **try/except**
  so a corrupted selector file can NEVER crash the backend (falls back to inline
  defaults + warns).
- **Overrides** stored in `data/selector_overrides.json`, merged ON TOP of base
  at load (override tried first). Selector readers must read DESKTOP LIVE (not a
  frozen import-time snapshot) so a healed selector works on the next attempt.
- **Self-Healing Selectors page** (`selector_healer.py` + UI): lists every
  action selector with base+override counts; "AI Heal" sends a DOM/screenshot to
  Claude (Opus tier) which PROPOSES new selectors (never auto-applies — user
  confirms); manual add/remove; on/off master toggle. Heal history for audit.

---

## 6. ANTI-DETECTION (the heart of the product)

1. **CDP real events** for ALL input — clicks, keypresses, AND scrolling
   (use CDP mouseWheel, not `window.scrollBy`/`scrollTo` which fire no wheel
   events and are detectable). Bezier curved mouse paths with random control
   points + dwell.
2. **Residential proxy** per profile (datacenter IP = instant flag).
3. **Organic navigation** — arrive via Search/Google/Bing/Channel page, not
   always direct. **Direct is FALLBACK only** (when organic fails to find the
   video). **Random traffic pool = search-type ONLY** (search, google, bing,
   channel) — EXCLUDES notification, direct, homepage (notification/homepage are
   manual; direct is fallback).
4. **Per-profile behavior variance via SHA256** (section 7).
5. **Natural watch focus** — mostly watch the video; occasional scroll to a
   comment then GRADUAL return (no snap-jump to top).
6. **Engagement velocity limits** — don't like/sub/comment too fast on fresh
   accounts.

---

## 7. SHA256 PER-PROFILE BEHAVIOR ENGINE (`session_behavior.py`)

For every (profile + session-nonce/date + video):
```
seed = sha256(f"{profile_id}|{nonce}|{video_id}").hexdigest()
rng  = random.Random(int(seed[:16], 16))
```
From this seed derive EVERYTHING so each profile is a different "person":
- **Action ORDER shuffled** (`rng.shuffle(order)`) — like-first vs comment-first etc.
- Trigger %s: like_at_pct, dislike_at_pct, sub_at_pct, desc_at_pct, seek_at_pct,
  comment_at_pct, pause_at_pct — all from seed.
- pause_hold_sec, seek_seconds, seek_dir, scroll_prob, mouse_prob — from seed.
- Same profile+video SAME day = reproducible; NEXT day = fresh pattern.
Result: no two profiles share a timing/order pattern; no global signature.

---

## 8. PAGES (frontend) — build all

Sidebar groups: **MAIN** (Dashboard, Scheduler, Profiles, Video Shuffle, Fleet),
**AUTOMATION** (Analytics, Engagement, Recycle, Channels, Backlinks, Comments,
Live Monitor, Future Agent), **SYSTEM** (Manual Control, Job Queue, Gmail Setup,
Proxy, Selector Healing, Logs, Settings).

- **Dashboard** — live KPIs (views, watch time, sessions, ads, likes/subs/comments) from `/api/analytics`.
- **Profiles** — list/create/start/stop/delete/recreate from provider; per-profile modal has **Profile Details + History (24h)** tabs (NO Settings tab — that was a duplicate).
- **Channels** — add/sync YouTube channels (RSS), their videos.
- **Video Shuffle** — pick videos (URL paste OR channel→video dropdown), assign to profiles, run settings, shuffle.
- **Engagement** — global defaults + **per-profile action matrix** (each profile its own like/dislike/sub/bell/comment/etc. toggles), **Watch% RANGE (min–max)** and **Volume RANGE** per profile (random within range — NOT a single value), traffic source incl. 🎲 Random, comment templates / AI comments, launch.
- **Analytics** — REAL data only (no mock); per-Gmail-profile **daily report** (videos, watch time, likes/subs/comments, ads) day-by-day, traffic breakdown, charts.
- **Scheduler** — create named schedules (time, days, profiles, task), timers, recurring.
- **Comments** — templates + **Smart Comments (AI) toggle** (transcript/title/top-comments → human-like comment).
- **Logs, Monitor, Manual Control, Job Queue, Gmail Setup, Proxy, Backlinks** — standard control/status pages, all wired to real backend.
- **Settings** — providers (MoreLogin/Multilogin) + test, proxy, concurrency,
  notifications, **AI Models tiered switcher** (Haiku/Sonnet/Opus dropdowns + on/off),
  **AI Features on/off** (Per-Profile Memory), **Upcoming AI Features** (Coming
  Soon placeholders with full descriptions: Vision Ad-Skip, AI Watch Director
  [RED/future], AI Persona).
- **Selector Healing** — section 5.
- **Future Autonomous Agent** — placeholder page (Level 3, research-first).

UX rules: full-width content, confirm destructive actions, loading skeletons,
empty states with CTA, color+icon for states (never color alone), one consistent
card/toggle/spacing system.

---

## 9. FLEET MODE (multi-laptop)

- `fleet_manager.py`: registry in `data/fleet_machines.json`; `get_agent_key()` +
  `regenerate_agent_key()` (per-laptop key in `data/fleet_agent_key.txt`);
  `get_this_laptop()` (hostname, LAN + Tailscale IPs, suggested address, key);
  `get_fleet_status()` (parallel-fetch each agent's `/api/agent/info`);
  `broadcast(ids, path, payload)` (parallel fan-out, partial-fail safe). Uses
  stdlib urllib + ThreadPoolExecutor — NO new dependency.
- Endpoints: `/api/agent/info` (this laptop: hostname + FULL profile list from
  provider, limit ≤100, merged with running-worker status),
  `/api/fleet/this-laptop` (+regenerate), `/api/fleet/machines` (GET/POST/DELETE),
  `/api/fleet/status`, `/api/fleet/broadcast`, `/api/agent/run-engagement`
  (receives fleet config → builds LOCAL engagement on this laptop's profiles).
- Auth middleware accepts the env/default key OR the generated agent key.
- **Fleet page:** "This Laptop" card (address + key, copy + regenerate),
  Add/Remove laptop, Overview (each laptop expand → its profiles, select),
  Engagement + Video Shuffle tabs (per-profile matrix, video queue [URL +
  channel dropdown], select-all/none, 🎲 random traffic), Broadcast result panel.
- Connectivity: **Tailscale** (stable 100.x IP, any network, encrypted) OR same
  LAN IP. Tailscale optional.

---

## 10. AI INTEGRATION (`ai_brain.py` + `ai_model_config.py`)

- Tiered models: simple=Haiku, balanced=Sonnet, powerful=Opus; task→tier map
  (`generate_comment`/`watch_pattern`=simple; `vision_ad_skip`/`scan_page`/
  `recover_error`=balanced; `selector_heal`/`popup_solve`=powerful). Settings UI
  picks model per tier; `reload_config()` after save.
- Functions: AI comment generation (title+description+top-comments+memory),
  keyword picking, persona keywords, watch-pattern, vision element find, error
  recovery. All gated by API key + on/off toggles.
- Per-profile memory (`profile_memory.py`): remembers channels visited + comments
  made → avoid repeats; toggle `aiProfileMemoryEnabled`.

---

## 11. BUILD ORDER (suggested)

1. Backend skeleton (Flask + auth + provider integration + profile list/start/stop).
2. nodriver CDP attach + the YouTube action engine (section 4) with verification.
3. SHA256 behavior engine (section 7) + entropy/traffic (section 6).
4. Ad-skip engine (selector + CDP click + self-healing hook).
5. Frontend shell (sidebar, design tokens, theme) + Profiles/Dashboard.
6. Engagement (per-profile matrix + ranges) + Video Shuffle + Analytics (real data).
7. Scheduler, Comments, Logs, Monitor, Settings (tiered AI), Selector Healing.
8. Fleet mode (agent identity → registry → status → broadcast → run-engagement).
9. AI features (comments, memory) with toggles.

**Verify everything by RUNNING it on a real profile and watching the result —
never claim it works from reading the code.**
