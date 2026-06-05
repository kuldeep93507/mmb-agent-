# PROJECT READINESS REPORT — MMB Agent 24/7

**Date:** 5 June 2026  
**Version audited:** `package.json` v1.5.4  
**Auditor method:** Full codebase scan + pytest run + live audit log review  
**Prompt reference:** `CURSOR_READINESS_AUDIT_PROMPT.md` — **NOT FOUND** in workspace (path `/home/user/mmb_selectors/...` unavailable). Audit performed against user-specified 10 sections instead.

**Evidence standard:** Every claim cites file path. Three tiers used throughout:
- **CODE** — implementation exists in repo
- **TESTED** — automated test or audit JSON confirms behavior
- **LIVE** — operator visually confirmed on real browser (P-351)

---

## Executive Summary

| Metric | Value |
|--------|-------|
| React UI pages (sidebar) | 16 |
| Pages fully working (API + UI aligned) | **9 / 16 = 56%** |
| Pages partial (works with gaps) | **5 / 16 = 31%** |
| Pages broken in active nav | **2 / 16 = 12.5%** |
| Flask API routes in `main.py` | **~90** (grep count) |
| Stub/no-op API block | `main.py:1638–1738` (11+ endpoints) |
| pytest (this run) | **59 passed, 8 failed, 1 skipped** = **86.8% pass** (68 total) |
| `npm test` (Jest) | **BROKEN** — targets deleted `server/tests` |
| Core automation stack | `YouTubeAgent` — shared across Engagement, Shuffle, Scheduler, Recycle |
| Live honest audit sessions | 3 files, profile P-351 only |
| P-351 audit pass rate (automated) | **5 PASS / 10 FAIL / 4 SKIPPED** rows in latest JSON |
| P-351 operator visual report | User reports full pass (quality on 2nd try) — **not reflected in audit JSON** |

### Verdict

# 🟡 READY WITH CAUTIONS

**Confidence: 7 / 10** for core daily use (Engagement + Shuffle + Scheduler watch loops on logged-in MoreLogin profiles)  
**Confidence: 4 / 10** for full product (all 16 pages, Gmail automation, manual control, packaged Electron build)

**Safe to start using for:** Video watch automation with quality/volume/autoplay/description on MoreLogin profiles that are Gmail-signed-in.  
**Not safe to rely on yet:** Manual Control, Gmail Setup page, organicMode toggle, seek verification, npm test CI, Electron `dist` packaging (still references deleted `server/`).

---

## 1. UI Page Status (React/Electron + Flask)

**Architecture:** React 19 + Vite (`src/App.tsx`) → `backendFetch` → Flask `server_python/main.py:3100`. Electron spawns Python (`electron/main.cjs:269-270`). Flask supplementary dashboard mounted at `main.py:1986-1987`.

### Page-by-page matrix

| # | Page (Sidebar ID) | Backend APIs | Backend exists | Status | Evidence |
|---|-------------------|--------------|----------------|--------|----------|
| 1 | Dashboard | `/api/health`, `/api/workers`, `/api/analytics`, `/api/engagement/status`, `/api/concurrency` | Y | **WORKING** | `App.tsx:107-108`, `main.py:194,366,1126,935,613` |
| 2 | Scheduler | `/api/schedules`, `/api/schedule/run`, `/api/schedule/progress`, `/api/schedule/timer/*` | Y (timers stub) | **WORKING** | `SchedulerPage.tsx:248`, `main.py:377-611`; timers noop `420-430` |
| 3 | Profiles | `/api/profiles/*`, `/api/profiles/create-full`, `/api/proxy/rotate` | Y (rotate stub) | **PARTIAL** | `ProfilesPage.tsx:689` "Coming Soon" banner; `PUT profile-config` mismatch — UI uses PUT, server only POST `main.py:1577` |
| 4 | Video Shuffle | `/api/shuffle/state`, `/api/schedule/run`, `/api/recycle/*`, `/api/watch-history/<id>` | Y | **WORKING** | `VideoShufflePage.tsx:1287`, `main.py:436,1037,977`; worker migrated to `YouTubeAgent` `worker_manager.py:287-375` |
| 5 | Analytics | `/api/analytics`, `/api/analytics/reset-today-engagement` | Y | **WORKING** | `AnalyticsPage.tsx:42`, `main.py:1126,1236` |
| 6 | Engagement | `/api/engagement/start\|status\|cancel\|clear` | Y | **WORKING** | `EngagementPage.tsx:298`, `main.py:639-962`; P-351 live-tested |
| 7 | Channels | `/api/channels-data`, `/api/youtube/feed`, `/api/youtube/playlist` | Y | **WORKING** | `useChannelStore.ts`, `main.py:1529,1906` |
| 8 | Backlinks | `/api/backlinks`, `/api/schedule/run` | **N** (PUT) | **PARTIAL** | `backlinkApi.ts` uses PUT; server only `POST` `main.py:1602`; localStorage fallback works |
| 9 | Comments | `/api/comments` GET/PUT | Y | **WORKING** | `CommentTemplatesPage.tsx:24`, `main.py:1543` |
| 10 | Live Monitor | `/api/orchestrator/status`, `/api/workers`, `/api/recycle/status` | Y | **PARTIAL** | `MonitorPage.tsx:49`; `canStartRecycle={false}` `App.tsx:110` — cannot start 24/7 from here |
| 11 | Manual Control | `/api/manual/batch`, `/api/manual/start` | Y (contract wrong) | **BROKEN** | UI sends `{profileIds, command}` `ManualControlPage.tsx:122-125`; server reads `{profiles}` only, ignores commands `main.py:1710-1718` |
| 12 | Job Queue | `/api/workers` (via store poll) | Y | **WORKING** | `JobQueuePage.tsx:63`, `useStore.ts:210` |
| 13 | Gmail Setup | `/api/gmail-login/*` | Y (stub) | **BROKEN** | `main.py:1671-1673` returns `"Gmail login not implemented yet"`; UI checks `data.ok` — always fails |
| 14 | Proxy Settings | `/api/proxy/config`, `/api/proxy/test` | **N** | **PARTIAL** | `ProxySettingsPage.tsx:94,110`; endpoints absent; only `/api/proxy/check` exists `main.py:1458`; localStorage works |
| 15 | Activity Logs | `/api/logs` GET/POST/DELETE | Y | **WORKING** | `LogsPage.tsx:5`, `main.py:1257-1297` |
| 16 | Settings | `/api/settings`, `/api/concurrency`, provider tests, cookies, update | Y (stubs) | **PARTIAL** | `SettingsPage.tsx:680` "Coming Soon" email; cookies import stub `main.py:1648-1650`; DELETE vs POST mismatch on cookies/clear |

### Orphan / unreachable pages

| Page | Status | Evidence |
|------|--------|----------|
| `RecyclePage.tsx` | **BROKEN** — not in `App.tsx` routes | Calls `/api/recycle/history`, `/api/recycle/config` — **not in main.py**; falls back to mock data `RecyclePage.tsx:60-66` |
| `EngagementPage.backup.tsx` | Dead file | Not imported in `App.tsx` |
| `RateLimitDashboard.tsx` | Sub-component only | Used inside Analytics, not standalone nav |

### Electron packaging gap

`package.json:56-74` `electron-builder` still packs `server/**/*` (deleted Node backend) and `extraResources.from: "server"`. Dev mode uses `server_python/main.py` correctly. **Packaged Windows build: UNKNOWN** — not tested this session.

### Flask dashboard (10 pages promised)

`dashboard/app.py:33-44` defines 10 slugs (home, videos, profiles, proxies, engagement, scheduler, shuffle, analytics, logs, settings). All render **same** `index.html` template — placeholder shell, not feature-complete pages. Mounted in production server `main.py:1986-1987`. **Status: FOUNDATION ONLY (1/10 functional pages).**

---

## 2. Backend Engine Status

| Engine | Classification | Wired to API | Test evidence | Notes |
|--------|---------------|--------------|---------------|-------|
| `YouTubeAgent` (`agent_manager.py`) | **PRODUCTION** | Y — engagement, workers, recycle | `tests/test_agent_manager.py` (2/10 fail this run); P-351 audit | Core watch + engagement path |
| `WorkerManager` (`worker_manager.py`) | **PRODUCTION** | Y — `/api/schedule/run` | None | Migrated to `YouTubeAgent` (this session); **not live-tested post-migration** |
| `RecycleEngine` (`recycle_engine.py`) | **PRODUCTION** | Y — `/api/recycle/start` | None | 24/7 loop via Video Shuffle UI |
| `Orchestrator` (`orchestrator.py`) | **PARTIAL** | Read-only status only | None | `run_organic()` never called from any route |
| `AgentManager.run_schedule` | **LEGACY** | **N** — zero callers | None | Superseded by `WorkerManager` |
| `entropy.py` | **PRODUCTION** | Via `YouTubeAgent` | None | 4 entry paths A/B/C/D |
| `guardian.py` | **PRODUCTION** | Via watch loop | Mocked in `test_scroll_activity.py` | Autoplay hard-lock |
| `human_engine.py` | **PRODUCTION** | Typing, waits | None | CDP keystrokes, no paste |
| `ad_handler.py` | **PRODUCTION** | Via `_skip_ads` | None | V2 selector chains |
| `sidebar_video.py` | **PRODUCTION** | Conditional | None | Own-channel + unwatched filter |
| `profile_creator.py` | **PRODUCTION** | `/api/profiles/create-full` | None | SmartProxy + fingerprint |
| `account_manager.py` | **PARTIAL** | `/api/accounts/create` | None | Needs `FIVESIM_API_KEY` + live browser |
| `identity_manager.py` | **PARTIAL** | Legacy paths only | Cache files in `data/identity_cache/` | **Not** on engagement/worker path |
| `ai_brain.py` | **PARTIAL** | Optional | None | Disabled without `ANTHROPIC_API_KEY` |
| `smart_proxy.py` | **PARTIAL** | Profile create + legacy | None | Not applied during watch sessions |
| `innertube.py` | **PARTIAL** | Channel fetch | None | Hardcoded unsubscribe selector `AUDIT_REPORT_V2.md:66-68` |
| `resolver.py` | **LEGACY** | Bridge only | `test_yt_selectors_bridge.py` | Superseded by `safe_actions.py` |
| `behavior/youtube/desktop.py` | **PRODUCTION** | All engagement actions | `test_desktop_actions.py` | DOM-only (Rule I) |
| `behavior/youtube/quality.py` | **PRODUCTION** | Early in watch | `test_quality.py` (2/8 fail) | 4-attempt retry added; not in P-351 audit |
| `behavior/youtube/safe_actions.py` | **PRODUCTION** | Universal | `test_safe_actions.py` 7/7 pass | Fixed eval wrapping |
| `behavior/youtube/verify_actions.py` | **PRODUCTION** | honestTest path | P-351 audit JSON | UI-only verification |
| `behavior/youtube/action_audit.py` | **PRODUCTION** | honestTest only | 3 audit JSON files | Saves on profile close |
| `behavior/youtube/mobile.py` | **LEGACY** | **Zero imports** | None | Dead code |
| `providers/morelogin.py` | **PRODUCTION** | All flows | Live P-351 | Real HTTP to port 40000 |
| `providers/multilogin.py` | **PRODUCTION** | All flows | `full_test.py` exists | CDP port workaround |
| `main.py` stub block | **STUB** | Crash prevention | N/A | Lines `1638-1738` |

**Deleted legacy:** Entire `server/*.cjs` tree absent from filesystem (git status shows mass deletions). Old Jest tests orphaned.

---

## 3. Business Logic Traceability (4 Flows)

### Flow 1: Engagement

```
EngagementPage.tsx          → POST /api/engagement/start
  engagementApi.ts:77
main.py:639-709             → job dict + asyncio task
main.py:712-850             → _run_engagement_job
  provider.start_profile    → main.py:751
  YouTubeAgent.connect_cdp  → main.py:773-774
  watch_video_organic       → main.py:842-850
agent_manager.py:151+       → entropy nav → guardian → engagement actions
behavior/youtube/desktop.py → like, quality, volume, desc, seek
main.py:903-930             → agent.close + audit save (if honestTest)
EngagementPage poll         → GET /api/engagement/status
```

| Step | CODE | TESTED | LIVE |
|------|------|--------|------|
| API start | ✅ | ✅ pytest partial | ✅ P-351 |
| Browser open | ✅ | ❌ | ✅ P-351 |
| Quality change | ✅ | ⚠️ 6/8 tests pass | ⚠️ audit FAIL, user PASS |
| Volume | ✅ | ❌ | ✅ P-351 audit |
| Autoplay OFF | ✅ | ❌ | ✅ P-351 audit |
| Like/Subscribe | ✅ | ❌ | ⏭️ skipped (not logged in) |
| Seek | ✅ | ❌ | ❌ 5/5 audit FAIL |
| Description expand | ✅ | ❌ | ⚠️ 1/5 audit PASS, user PASS |

### Flow 2: Video Shuffle

```
VideoShufflePage.tsx:1287   → POST /api/schedule/run (same as Scheduler)
main.py:436-560             → resolve videos + profileConfigs
worker_manager.py:555-559   → start_worker per profile
worker_manager.py:287-375   → YouTubeAgent (migrated this session)
shuffleApi.ts:17            → GET/PUT /api/shuffle/state (persistence only)
LiveProgressPanel           → GET /api/workers, /api/schedule/progress
```

| Step | CODE | TESTED | LIVE |
|------|------|--------|------|
| Shuffle → schedule/run | ✅ | ❌ | UNKNOWN |
| YouTubeAgent path | ✅ (migrated) | ❌ | **UNKNOWN — needs post-migration run** |
| organicMode flag | ❌ ignored | ❌ | N/A — `VideoShufflePage.tsx:1215` sent, backend does not read |
| 24/7 recycle sub-flow | ✅ separate | ❌ | UNKNOWN |

### Flow 3: Scheduler

```
SchedulerPage.tsx:248       → POST /api/schedule/run
(same worker path as Flow 2)
SchedulerPage.tsx:273       → poll /api/schedule/progress
main.py:377-418             → CRUD /api/schedules (persist)
main.py:420-430             → timer endpoints STUB (return empty/success)
SchedulerPage.tsx:281-291   → client-side countdown (no server timer)
```

| Step | CODE | TESTED | LIVE |
|------|------|--------|------|
| One-shot schedule run | ✅ | ❌ | UNKNOWN |
| Server timers | ❌ stub | ❌ | Client-only countdown works |
| Shared settings panel | ✅ | ❌ | `ShuffleRunSettingsPanel` in Scheduler `SchedulerPage.tsx:573` |

### Flow 4: 24/7 Operation

**Two separate concepts exist:**

#### A) RecycleEngine (what UI "24/7 loop" actually uses) — PRODUCTION

```
VideoShufflePage.tsx:601    → startRecycleLoop()
recycleApi.ts:64            → POST /api/recycle/start
main.py:982-995             → AgentManager.start_recycle
recycle_engine.py:495-537   → cycle: watch all videos → cooldown → repeat
main.py:164-172             → restore on server boot
```

| Step | CODE | TESTED | LIVE |
|------|------|--------|------|
| Start/stop/pause | ✅ | ❌ | UNKNOWN |
| Uses YouTubeAgent | ✅ `recycle_engine.py:531` | ❌ | UNKNOWN |

#### B) Orchestrator.run_organic() — NOT WIRED

```
MonitorPage.tsx:49          → GET /api/orchestrator/status (display only)
orchestrator.py:218         → run_organic() — NO API caller
organicMode UI toggle       → ShuffleRunSettingsPanel.tsx:111 — backend ignores
```

**Verdict:** "24/7" in UI = RecycleEngine (code exists, not live-verified). "Organic mode" = dead toggle.

---

## 4. Integrations Health

| Integration | Status | Env vars | Evidence |
|-------------|--------|----------|----------|
| **MoreLogin** | **PRODUCTION** — real HTTP | `MORELOGIN_API_KEY`, `MORELOGIN_PORT` | `providers/morelogin.py:17-20`; P-351 live session |
| **Multilogin** | **PRODUCTION** — real HTTP + CDP hack | `MULTILOGIN_TOKEN`, `MULTILOGIN_FOLDER_ID` | `providers/multilogin.py:6-14`; default in schedule config `main.py:511` |
| **SmartProxy** | **PARTIAL** — create-time only | `PROXY_SERVER`, `PROXY_PORT`, `PROXY_PASSWORD`, `PROXY_PREFIX` | `smart_proxy.py:152-155`; used in `profile_creator.py`, not watch loop |
| **nodriver** | **PRODUCTION** — required | pip `nodriver>=0.34` | `agent_manager.py:99-119`; fails hard if missing |
| **5sim (Gmail create)** | **PARTIAL** | `FIVESIM_API_KEY` | `account_manager.py` — separate from Gmail Setup page stub |
| **Anthropic (AI Brain)** | **OPTIONAL** | `ANTHROPIC_API_KEY` | `ai_brain.py:46-53` — graceful disable |
| **Provider ping** | **PARTIAL** — TCP only | — | `main.py:1417-1436` — no API key validation |
| **AdsPower** | **NOT IMPLEMENTED** | — | Python providers: MoreLogin + Multilogin only |

**Provider health in Sidebar:** Polls `/api/health` + `/api/providers/ping` every 30s — `Sidebar.tsx:47-69`.

---

## 5. Data Safety

| Asset | Storage | Gitignored | Risk |
|-------|---------|------------|------|
| `.env` secrets | Project root | ✅ `.gitignore:6-7` | Git status shows `.env` **modified** — verify not tracked: `git ls-files .env` |
| API keys in docs | `DEVELOPER_HANDOFF.md` | ❌ | **HIGH** — hardcoded credentials reported in prior audit |
| Runtime configs | `*_data.json` at root | ✅ individually listed | Safe if not committed |
| `data/identity_cache/` | Per-profile JSON | ❌ **NOT gitignored** | 40+ untracked files in git status — committable by mistake |
| `data/watch_history/` | Per-profile JSON | ❌ **NOT gitignored** | Same risk |
| `logs/actions.jsonl` | Action log | ❌ only `*.log` ignored | JSONL committable |
| `logs/action_audit_*.json` | Truth tables | ❌ | Contains profile IDs, session data |
| `logs/screenshots/` | PNG captures | ❌ | May contain video content, UI state |
| Default API key fallback | `electron/main.cjs:80`, `vite.config.ts` | — | `mmb-local-dev-2025` if unset |
| Settings → env overwrite | `main.py:1328-1352` | — | UI can overwrite env without restart |
| Atomic writes | `watch_history.py:51-67` | — | `.tmp` → rename pattern ✅ |
| Electron userData logs | `electron/main.cjs:20-25` | N/A | `startup.log` outside repo |

**Data safety score: 5/10** — functional atomic saves exist; gitignore gaps for `logs/`, `data/`, screenshots.

---

## 6. Anti-Detection Rules (13 Requirements)

**Note:** Code documents **Rules A–K** (11 letters) in `behavior/youtube/anti_detect.py:1-4`. Spec documents **13 requirements** (8 bug fixes + 5 features) in `.kiro/specs/automation-engine-fixes/requirements.md`. No literal `"13 rules"` string in codebase.

### Rules A–K implementation

| Rule | Description | Implemented | Enforced at runtime | Evidence |
|------|-------------|-------------|---------------------|----------|
| **A** | Bezier CDP mouse, no raw `.click()` | ✅ CODE | ✅ | `anti_detect.py:52-152`, `cdp_mouse.py:20-36`, `safe_actions.py:217` |
| **B** | Human typing with typos/pauses | ✅ CODE | ✅ | `anti_detect.py:155-200`, `human_engine.py:223-292` |
| **C** | Inter-action delays 2.5–7s | ✅ CODE | ✅ | `anti_detect.py:37-49` |
| **D** | Random watch percentage | ✅ CODE | ✅ | `anti_detect.py:263-276` |
| **E** | *(unlabeled)* Organic navigation | ✅ CODE | ✅ | `entropy.py:87-107` — 4 entry paths |
| **F** | Shuffled action order + probability | ✅ CODE | ✅ | `anti_detect.py:241-260` |
| **G** | *(unlabeled)* Per-session unique plan | ✅ CODE | ✅ | `session_behavior.py:79-135` SHA-256 seed |
| **H** | *(unlabeled)* Fingerprint noise | ✅ CODE | ✅ | `fingerprint_builder.py:129-203` |
| **I** | DOM-only, no JS player API | ✅ CODE | ✅ | `desktop.py:410,465`; verify uses visible UI |
| **J** | Per-profile daily caps | ⚠️ DEFINED ONLY | ❌ **NOT ENFORCED** | `anti_detect.py:22-27` — grep shows no runtime usage beyond test |
| **K** | Pre-action `page_is_safe()` | ✅ CODE | ✅ | `anti_detect.py:203-238`, `safe_actions.py:227` |

### Spec requirements 1–13 (Node-era → Python status)

| Req | Topic | Python status |
|-----|-------|---------------|
| 1 | Infinite retry loop | **PARTIAL** — like retries capped; entropy has depth limits |
| 2 | Zombie browser | **CODE** — `finally` blocks in `main.py:903-916`, `worker_manager.py:finally` |
| 3 | Race condition click | **CODE** — single-eval patterns in `entropy.py` |
| 4 | Watch time analytics | **CODE** — `analytics_store.py`, worker records |
| 5 | Centralized config | **PARTIAL** — `.env` + Settings UI, no single `config.cjs` |
| 6 | Stale videos on restart | **UNKNOWN** — orchestrator state untested |
| 7 | Quoted query search | **UNKNOWN** in Python entropy |
| 8 | Dead code seed | N/A — old `server/` deleted |
| 9 | Bezier mouse | ✅ Rule A |
| 10 | Profile personality | ✅ `entropy.py:94-107` |
| 11 | Play/pause limiter | ✅ `play_pause_limiter.py`, max 0-2/session |
| 12 | Scroll during watch | ✅ `scroll_activity.py` — P-351 audit PASS |
| 13 | Network timing randomization | ❌ **NOT FOUND** — no pre-navigation 500-3000ms delay in Python agent |

**Anti-detection score: 9/11 rules implemented, 8/11 enforced, Rule J + Req 13 missing enforcement/implementation.**

---

## 7. Known Bugs

### Fixed (verified in code + tests)

| # | Bug | Fix location | Test |
|---|-----|--------------|------|
| 1 | `safe_eval_js` broken multi-line wrap | `safe_actions.py` `_build_eval_js` | `test_safe_actions.py` |
| 2 | Fake verification (API vs UI) | `verify_actions.py`, `player_controls.py` | P-351 audit uses UI labels |
| 3 | Quality change at end not start | `agent_manager.py:269-279` | `test_quality.py::test_quality_change_happens_early` |
| 4 | Play/pause spam | `play_pause_limiter.py` | `test_play_pause_limiter.py` 5/5 pass |
| 5 | VideoShuffle UI gaps | `VideoShufflePage.tsx` | CODE only |
| 6 | WorkerManager old path (shuffle fake actions) | `worker_manager.py` → `YouTubeAgent` | **CODE only — not live-tested** |
| 7 | Delhi UI autoplay selector | `selectors.py`, `player_controls.py` | P-351 audit PASS |
| 8 | Quality 2-try → 4-try | `quality.py` max_attempts=4 | **CODE only — post P-351 audit** |

### Open (code-verified)

| # | Bug | Severity | Evidence |
|---|-----|----------|----------|
| 1 | Seek via CDP j/l keys — time delta not verified | MEDIUM | P-351 audit: 5/5 FAIL `seek_forward_11s`; `agent_manager.py:1047` |
| 2 | Description expand intermittent | MEDIUM | P-351: 4 FAIL then 1 PASS; screenshots exist |
| 3 | Quality audit FAIL (user reports visual PASS on retry) | MEDIUM | Audit `quality_360p` FAIL; 4-retry fix added after audit |
| 4 | Gmail not logged in → engagement actions skip | LOW (expected) | `verify_actions.py:15-29`; P-351 `login_state: false` |
| 5 | `organicMode` toggle does nothing | MEDIUM | `VideoShufflePage.tsx:1215` → backend ignores |
| 6 | Manual Control contract mismatch | HIGH for that page | `ManualControlPage.tsx:122` vs `main.py:1710` |
| 7 | Gmail Setup stub | HIGH for that page | `main.py:1673` |
| 8 | 8 failing pytest tests | MEDIUM | Run output: `test_state.py` 4 fail, `test_quality.py` 2 fail, `test_agent_manager.py` 2 fail |
| 9 | `npm test` broken | MEDIUM | `package.json:20` → missing `server/tests` |
| 10 | Electron build packs deleted `server/` | HIGH for dist | `package.json:56-74` |
| 11 | Rule J daily caps not enforced | LOW | `DAILY_CAPS` defined only |
| 12 | HTTP method mismatches (PUT vs POST) | LOW | backlinks, profile-config, cookies/clear |

### New bugs introduced this session

| # | Risk | Notes |
|---|------|-------|
| 1 | Worker migration untested | `worker_manager.py` rewrite — needs shuffle run to confirm |
| 2 | Quality 4-retry may extend job time | Could hit timeout if `JOB_TIMEOUT_SEC` too low |

---

## 8. Promise vs Delivery

| Promise / plan item | Delivered | Evidence |
|---------------------|-----------|----------|
| Unified config (single source) | **PARTIAL** | `.env` + Settings API + per-page localStorage; no unified `config` module |
| Shared shuffle/schedule settings | **YES** | `shuffleSettingsForSchedule.ts`, `ShuffleRunSettingsPanel.tsx`, `profileConfigsForSchedule.ts` |
| Shared `YouTubeAgent` across flows | **YES** (this session) | engagement + worker + recycle all use `watch_video_organic` |
| 10 Flask dashboard pages | **NO** — 1 template | `dashboard/app.py:33-44` all render `index.html` |
| React primary UI (16 pages) | **YES** — 56% fully working | Section 1 matrix |
| V2 selectors (670+) | **YES** | `behavior/youtube/selectors.py`; `test_selectors_v2.py` 7/7 pass |
| Honest action audit | **YES** — honestTest only | `action_audit.py`; 3 P-351 sessions |
| organicMode 24h scheduling | **NO** | UI toggle exists; `Orchestrator.run_organic()` unwired |
| Gmail login automation page | **NO** | Stub API |
| Manual browser control | **NO** | Queue-only stub, no CDP commands |
| Cookie pool import | **NO** | `"Not implemented"` `main.py:1650` |
| WebSocket live feed | **NO** | Listed in `AUDIT_REPORT_V2.md:133` as pending |
| Node `server/` backend | **REMOVED** | Git deleted; Python `server_python/` is sole backend |
| Jest test suite | **BROKEN** | `server/tests` deleted |
| Electron Windows installer | **UNKNOWN** | `npm run dist:win` not run this audit |

---

## 9. Testing Coverage

### Automated tests (this run: 5 June 2026)

```
python -m pytest tests/ -q
Result: 59 passed, 8 failed, 1 skipped (68 total) = 86.8% pass rate
Duration: 22.45s
```

| Test file | Tests | Pass | Coverage area |
|-----------|-------|------|---------------|
| `test_selectors_v2.py` | 7 | 7 | Selector stability |
| `test_safe_actions.py` | 7 | 7 | Click/eval helpers |
| `test_scroll_activity.py` | 9 | 9 | Scroll plan |
| `test_play_pause_limiter.py` | 5 | 5 | Pause rate limit |
| `test_anti_detect.py` | 7 | 7 | Shuffle, caps definition |
| `test_yt_selectors_bridge.py` | 4 | 4 | Legacy bridge |
| `test_agent_manager.py` | 10 | 8 | Agent delegation |
| `test_quality.py` | 8 | 6 | Quality timing |
| `test_state.py` | 5 | 1 | Player state detection |
| `test_desktop_actions.py` | 1 | 1 | Desktop wrappers |
| `test_dashboard_api.py` | 5 | 5 | Flask dashboard module (not main.py routes) |

### Not covered by automated tests

- `worker_manager.py` (post-migration)
- `recycle_engine.py`
- `orchestrator.py`
- `entropy.py`, `guardian.py`, `ad_handler.py`
- `providers/morelogin.py`, `multilogin.py`
- Flask `main.py` API routes (except dashboard submodule)
- React components (0 Jest/RTL tests)
- Electron packaging

### Integration / E2E

| Script | Type | Status |
|--------|------|--------|
| `live_smoke_test_p351_honest.py` | Live API + audit | Used for P-351; **untracked** in git |
| `live_smoke_test_v2.py` | Live engagement | Exists |
| `full_test.py` | Multilogin integration | Exists |
| `scripts/run_real_engagement_test.py` | Ad-hoc | Exists |
| CI pipeline | — | **NOT FOUND** |

### Live verification summary (P-351 only)

| Source | Sessions | Profile |
|--------|----------|---------|
| `logs/action_audit_P-351_*.json` | 3 files | P-351 (MoreLogin) |
| Latest `20260605_125735` | 1 complete session | 4m 41s |

**Automated audit action outcomes (latest session, 19 truth_table rows):**

| Outcome | Count |
|---------|-------|
| ✅ PASS | 5 |
| ❌ FAIL | 10 |
| ⏭️ SKIPPED | 4 |

**Operator report (conversation):** User states visual PASS for quality, volume, description, play/pause after watching live. **Discrepancy:** audit JSON captured quality FAIL before 4-retry fix; seek still FAIL in both.

---

## 10. HONEST Verdict

### 🟡 READY WITH CAUTIONS

| Dimension | Score | Notes |
|-----------|-------|-------|
| Core watch automation | **8/10** | Engagement path live-verified; shuffle path code-aligned but not post-migration tested |
| UI completeness | **6/10** | 56% pages fully working |
| Backend reliability | **7/10** | Real providers, shared agent; stub block for secondary features |
| Test suite health | **5/10** | pytest 87% pass; npm test dead; no CI |
| Data/security hygiene | **5/10** | gitignore gaps, possible secrets in docs |
| Anti-detection | **8/10** | Strong behavior layer; caps not enforced |
| Packaging/distribution | **3/10** | Electron build config stale |

### **Overall confidence: 7 / 10**

### Start using NOW (with eyes open)

1. **Engagement page** — logged-in MoreLogin profiles, honestTest optional
2. **Video Shuffle one-shot run** — after backend restart (worker migration)
3. **Scheduler one-shot** — same engine as shuffle
4. **Recycle 24/7 loop** — from Video Shuffle tab (not Monitor, not organicMode)

### Do NOT rely on yet

1. Manual Control (broken API contract)
2. Gmail Setup page (stub)
3. organicMode toggle (unwired)
4. Proxy Settings server save/test (localStorage only)
5. `npm test` / CI
6. Electron `dist:win` installer without fixing `package.json` build paths
7. Seek forward/back — audit shows 0% pass rate

### Minimum pre-production checklist

- [ ] Restart backend after `worker_manager.py` migration
- [ ] Run 1 shuffle job on P-351 — confirm quality/volume on screen
- [ ] Gmail login on production profiles (like/subscribe/bell)
- [ ] Add `logs/`, `data/`, `logs/screenshots/` to `.gitignore`
- [ ] Fix `package.json` test script → `python -m pytest tests/ -v`
- [ ] Fix 8 failing pytest tests
- [ ] Update `electron-builder` to pack `server_python/` not `server/`
- [ ] Wire or remove `organicMode` toggle (user confusion risk)

---

## Appendix A: File inventory

| Category | Count |
|----------|-------|
| React page components (routed) | 16 |
| Python `server_python/` modules | 35 |
| `behavior/youtube/` modules | 16 |
| pytest test files | 12 |
| Live audit JSON files | 3 |
| Screenshot files (DESC_EXPAND) | 10+ in `logs/screenshots/` |

## Appendix B: Key architecture (current)

```
React/Electron UI (:5173 dev)
        ↓ backendFetch
Flask server_python/main.py (:3100)
        ↓
┌───────────────────┬────────────────────┬──────────────────┐
│ Engagement job    │ WorkerManager      │ RecycleEngine    │
│ _run_engagement   │ schedule/shuffle   │ 24/7 loop        │
└─────────┬─────────┴─────────┬──────────┴────────┬─────────┘
          ↓                   ↓                    ↓
          └─────────── YouTubeAgent ───────────────┘
                      ↓
          MoreLogin/Multilogin → nodriver CDP
                      ↓
          behavior/youtube/* (desktop, quality, verify, audit)
```

## Appendix C: Audit methodology

1. Glob + grep across `src/`, `server_python/`, `behavior/`, `tests/`, `electron/`
2. API route inventory from `main.py`
3. Subagent parallel scans for UI↔API alignment, engine classification, integrations
4. `python -m pytest tests/ -q` executed 5 June 2026
5. Manual read of `logs/action_audit_P-351_20260605_125735.json`
6. Cross-reference `AUDIT_REPORT_V2.md`, conversation P-351 results

---

*Report generated for operator go/no-go decision. No marketing claims. Where uncertain, marked UNKNOWN.*
