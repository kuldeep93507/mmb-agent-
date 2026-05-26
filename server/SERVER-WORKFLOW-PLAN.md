# MMB Agent — Server Core Plan & Workflow

> **Purpose of this document:** Deep map of `server/` core files — what each does, how they connect, and the phased plan to make **everything work correctly** (traffic → YouTube → human watch → logs).
>
> **Rule:** If this pipeline works end-to-end on profile P-351, the product works.

---

## 1. Project maqsad (goal)

| # | Goal | Proof in logs/UI |
|---|------|------------------|
| 1 | Open antidetect profile (Multilogin / MoreLogin) | `Profile started! CDP port: …` |
| 2 | Reach target YouTube video via **chosen traffic source** | `[Traffic] Opened via: google` (not `direct-fallback` unless direct test) |
| 3 | Verify correct video (title / channel / videoId) | `[Verify] Confirmed: "…"` |
| 4 | Watch with human behavior | scroll, ads skip ~15s, 144p, seek, like/comment |
| 5 | Log everything server-side | Activity Logs + `activity_logs.json` |
| 6 | UI controls schedules, shuffle, settings | `index.cjs` APIs |

**YouTube open = halfway.** Real success = **correct referral path + watch + engagement + clean stop.**

---

## 2. Master workflow (one video, one profile)

```
┌─────────────┐     POST /api/schedule/run      ┌──────────────────┐
│  React UI   │ ──────────────────────────────► │   index.cjs      │
└─────────────┘                                 │  validate, log   │
                                                └────────┬─────────┘
                                                         │
                                                runSchedule()
                                                         ▼
                                                ┌──────────────────┐
                                                │ orchestrator.cjs │
                                                │ spawn worker     │
                                                └────────┬─────────┘
                                                         │ worker_threads
                                                         ▼
                                                ┌──────────────────┐
                                                │   worker.cjs     │
                                                │ startProfile()   │
                                                │ CDP connect      │
                                                └────────┬─────────┘
                                                         │
                                                         ▼
                                                ┌──────────────────┐
                                                │   agent.cjs      │
                                                │ ProfileAgent     │
                                                └────────┬─────────┘
                                    ┌────────────────────┼────────────────────┐
                                    ▼                    ▼                    ▼
                          searchEngine.cjs      agentBrain.cjs      profileRecovery.cjs
                          (open video)          (verify, blocks)    (on captcha/sign-in)
                                    │
                                    ▼
                          YouTube watch loop
                          (ads, quality, watchVideo)
                                    │
                                    ▼
                          activityLog.cjs ◄── logs via orchestrator.onActivityLog
```

### Worker status machine

| Status | Meaning |
|--------|---------|
| `waiting` | Start delay |
| `starting` | Multilogin/MoreLogin launching |
| `connecting` | Playwright CDP attach |
| `running` | Connected, between videos |
| `watching` | Active video session |
| `done` | Queue finished |
| `error` / `crashed` | Failed; orchestrator may retry (max 3) |

---

## 3. File-by-file plan

### 3.1 `index.cjs` — API gateway & scheduler hub

**Role:** Express server on port **3100**. Bridge between UI and backend engine.

**Key responsibilities:**
- Load `.env` via `providers/loadEnv.cjs`
- Mount **orchestrator** + wire callbacks:
  - `onActivityLog` → `activityLog.append`
  - `onWorkerDone` → cleanup running schedules
  - `onBacklinkUsed` → mark backlinks used
- **Profile APIs** via `profileRouter` (Multilogin list, test connection)
- **Schedule:** `POST /api/schedule/run`, `POST /api/schedule/stop`, timer jobs
- **Workers:** `GET /api/workers`, `GET /api/workers/:profileId`
- **Logs:** `GET/POST/DELETE /api/logs`
- **Analytics, history, shuffle, backlinks, proxy rotate, settings** (apply to env without wiping secrets)

**Workflow when user clicks Run Schedule:**
1. Receive `schedule` JSON (profiles, videos, `profileConfigs`)
2. Concurrency check vs `MULTILOGIN_MAX_CONCURRENT`
3. `activityLog.append` — schedule started
4. `orchestrator.runSchedule(schedule)`
5. Return `{ success, message }`

**Dependencies:** `orchestrator`, `activityLog`, `ProfileAgent` (manual path), `profileRouter`, `ProviderFactory`

**Plan / fixes:**
| Priority | Task |
|----------|------|
| P0 | `applySettingsToEnv` — never overwrite `.env` with empty JSON fields |
| P1 | Health endpoint shows worker + schedule state (already) |
| P2 | Optional: expose last `[Traffic] Opened via` per worker in API |

---

### 3.2 `orchestrator.cjs` — Worker pool manager

**Role:** One **Node worker thread** per profile (`worker.cjs`). Crash isolation.

**Key methods:**
| Method | Action |
|--------|--------|
| `startWorker(profileId, name, videos, config, startDelay)` | Spawn thread, postMessage `start` |
| `stopWorker` / `stopAll` | Send `stop`, terminate after 3s |
| `runSchedule(schedule)` | Loop profiles → build video list → `buildAgentConfig` → staggered start |
| `getStats` / `getWorkerStatus` | For UI + E2E script |

**Message handling from worker:**
- `status` → update state (watching, done, …)
- `log` → `onActivityLog`
- `done` → store `results`, `onWorkerDone`
- `error` → auto-restart with **remainingVideos** (max 3 retries)

**Multilogin batching:** Respects `MULTILOGIN_MAX_CONCURRENT` + `MULTILOGIN_BATCH_GAP_MS` between spawns.

**Dependencies:** `worker.cjs`, `agentBrain.buildAgentConfig`

**Plan / fixes:**
| Priority | Task |
|----------|------|
| P0 | Don't mark schedule "success" if all workers errored |
| P1 | On CDP failure, longer stop+retry before giving up |
| P2 | Pass `qaTestMode` / `qaMaxWatchSec` through unchanged (already via buildAgentConfig) |

---

### 3.3 `worker.cjs` — Per-profile isolated runner

**Role:** Runs in **separate thread**. Owns browser lifecycle for one profile.

**Step-by-step workflow:**
1. **Wait** `startDelay` (stagger)
2. **Start profile** — `providerFactory.getProvider(browserType).startProfile(profileId)`
   - Retry once after 10s if no CDP port
3. **Multilogin warm-up** — 6s sleep before CDP
4. **Create `ProfileAgent`** with `onLog`, `onRecoverProfile` → `profileRecovery.cjs`
5. **Connect CDP** — `connectWithRetry(12, 4000)` for Multilogin
6. **For each video in queue:**
   - Build `watchConfig` (title, channel, url, traffic prefs)
   - If `trafficPreference === 'direct'` → `agent.watchByUrl`
   - Else → `agent.searchAndWatch`
   - Track `results.watched` / `failed`
7. **Stop profile** via provider
8. **sendDone** with results

**Dependencies:** `agent.cjs`, `profileRecovery.cjs`, `ProviderFactory`, `loadEnv`

**Plan / fixes:**
| Priority | Task |
|----------|------|
| P0 | Clear error when profile open but no CDP — user must stop in MLX |
| P1 | After video fail, don't count as watched |
| P2 | Report `openedVia` in results object for E2E |

---

### 3.4 `agent.cjs` — Browser automation brain (main work after CDP)

**Role:** `ProfileAgent` class — Playwright over CDP. **All human-like YouTube behavior.**

**Key methods:**

| Method | When | What |
|--------|------|------|
| `connect` / `connectWithRetry` | Start | Attach to `127.0.0.1:cdpPort` |
| `warmup` | First video | Homepage browse, detect Android UA |
| `searchAndWatch` | Most traffic modes | Traffic → open video → watch |
| `watchByUrl` | `direct` preference | Skip search, goto URL |
| `handleAds` | Before duration read | Skip after N sec |
| `getVideoDuration` | After ads | Real video length |
| `watchVideo` | Core | Scroll, play checks, like, comment, seek |
| `recoverFromPageBlock` | Block detected | Calls worker's `onRecoverProfile` |

**`searchAndWatch` internal flow:**
1. Detect **Android** vs desktop (`isAndroidUA`)
2. **Mobile + external engine** (`google|bing|yahoo|duckduckgo|direct`) → `openVideoSmart` (real sites)
3. **Mobile + youtube search** → `mobileYouTubeSearch` (m.youtube.com)
4. **Desktop** → `openVideoSmart` or backlink path
5. Log `[Traffic] Opened via: {source}`
6. `verifyOpenedVideo` (agentBrain)
7. `disableAutoplay`, `setVideoQuality`, `handleAds`, `watchVideo`
8. Analytics + watch history

**Mobile helpers (top of file):** `mobileYouTubeSearch`, `mobileDirectWatch`

**Dependencies:** `searchEngine`, `agentBrain`, `humanType`, engagement utils

**Plan / fixes:**
| Priority | Task |
|----------|------|
| P0 | QA mode: `qaMaxWatchSec` cap on watch time (long videos) |
| P0 | Pass `strictTraffic` to `openVideoSmart` when `qaTestMode` |
| P1 | Android Google: ensure consent dismissed before type |
| P2 | Like/comment only after min watch % in QA |

---

### 3.5 `searchEngine.cjs` — Traffic & video discovery

**Role:** **How** the browser reaches the YouTube watch page.

**Traffic assignment:** `assignTrafficSource(profileIndex, …, trafficMix, trafficPreference)`

**Source implementations:**

| Function | Site | Opens video by |
|----------|------|----------------|
| `searchYouTube` | youtube.com | Escalation queries + verify match |
| `searchGoogle` | google.com | Search → YT link → `openYouTubeResultLink` |
| `searchBing` | bing.com | Same pattern |
| `searchDuckDuckGo` | duckduckgo.com | Same |
| `searchYahoo` | search.yahoo.com | Same + `dismissYahooPromo` |
| `searchChannelPage` | youtube.com/channel | Channel tab → video |
| `openVideoSmart` | Router + **fallback chain** | Primary → fallbacks → direct URL last |
| `openVideoViaBacklink` | External site | Referrer path |

**Helpers (added for mobile):**
- `dismissSiteOverlays` — cookie/consent
- `typeInExternalSearch` — force focus/type
- `openYouTubeResultLink` — navigate href (avoid click intercept)

**QA strict mode:** `options.strictTraffic` — **no fallback chain**, no direct URL rescue.

**Verification:** `verifyVideoMatch` — title/channel word match before click.

**Plan / fixes:**
| Priority | Task |
|----------|------|
| P0 | Google/Bing result match: also match by `expectedVideoId` from URL |
| P0 | Yahoo promo overlay — dismiss before every click |
| P1 | Log query string in `[Traffic] Opened via: google | query: "…"` |
| P2 | Per-source success rate in analytics |

---

### 3.6 `agentBrain.cjs` — Rules, config, safety checks

**Role:** **No LLM** — pure rules for config normalization and page safety.

**Exports:**

| Export | Use |
|--------|-----|
| `resolveTrafficMix` | `trafficPreference` → % mix |
| `buildAgentConfig` | Schedule row → worker config object |
| `detectPageBlock` | Sign-in, captcha, consent walls |
| `verifyOpenedVideo` | Post-open title/channel/id check |
| `planScrollActions` | Watch-time scroll schedule |

**Used by:** `orchestrator` (config), `agent` (blocks, verify), `searchEngine` (verifyVideoMatch import)

**Plan / fixes:**
| Priority | Task |
|----------|------|
| P1 | `buildAgentConfig` include `qaMaxWatchSec`, `dislikeEnabled` |
| P2 | Android-specific block phrases |
| P2 | Stricter verify when `qaTestMode` |

---

### 3.7 `activityLog.cjs` — Central logging store

**Role:** Ring buffer (max **2000** entries) + debounced save to `activity_logs.json`.

**API surface:**
- `append({ level, message, profileId, profileName, source, timestamp })`
- `getLogs({ limit, level, source, profileId, search })`
- `clear()`
- `inferScheduleSource(schedule)` → `scheduler` | `shuffle`

**Sources:** `profile`, `worker`, `scheduler`, `shuffle`, `backlink`, `manual`, `settings`, `system`

**Wired from:** `index.cjs` routes, `orchestrator.onActivityLog`, UI `POST /api/logs`

**Plan / fixes:**
| Priority | Task |
|----------|------|
| P1 | Optional filter `messageContains` for E2E |
| P2 | Rotate/archieve old logs by date |

---

### 3.8 `profileRecovery.cjs` — Recovery when blocked

**Role:** When YouTube shows sign-in / captcha / bot check.

**Strategies:**
| Strategy | Steps |
|----------|-------|
| `clear_cache` | stop → clear cache (MoreLogin) → restart → return new `cdpPort` |
| `recreate` | stop → `RecreateHandler` delete+create → new profileId |

**Called from:** `worker.cjs` via `agent.onRecoverProfile` → `agent.recoverFromPageBlock`

**Plan / fixes:**
| Priority | Task |
|----------|------|
| P1 | Multilogin cache clear if API exists |
| P2 | Max 1 recreate per session |

---

### 3.9 `test-browsers.cjs` — Provider integration test (dev only)

**Role:** CLI script — **not** production watch path.

**Tests per provider:** list → create → start → verify CDP → stop → delete

**Usage:** `node server/test-browsers.cjs`

**Plan:** Run after any Multilogin/MoreLogin credential or API change.

---

## 4. Supporting files (same folder, not in your list but required)

| Path | Role |
|------|------|
| `providers/MultiloginProvider.cjs` | Start/stop profile, CDP port, retry if already open |
| `providers/MoreLoginProvider.cjs` | Same for MoreLogin |
| `providers/ProviderFactory.cjs` | Pick provider by `browserType` |
| `providers/profileRouter.cjs` | `/api/profiles/*` routes |
| `providers/loadEnv.cjs` | Load `.env` |
| `scripts/e2e-traffic-qa.cjs` | Automated per-source QA (calls `index` API) |
| `services/*` | Profile create, proxy, cookies, recreate |

**Without providers, `worker.cjs` cannot start a browser.**

---

## 5. Current state vs target (honest)

| Area | Status |
|------|--------|
| Backend + logs + Multilogin list | ✅ Working |
| Video watch + QA behaviors (when CDP OK) | ✅ Working |
| Real Google/Bing/Yahoo referral on Android | ⚠️ Partial — often falls back to `direct-fallback` |
| Full 6-source E2E on P-351 | ❌ Not all PASS |
| CDP when profile stuck open in MLX | ❌ Intermittent |

---

## 6. Phased execution plan (fix order)

### Phase A — Infrastructure stable
1. User: profile **fully stopped** in Multilogin before each test
2. Verify `.env`: `MULTILOGIN_EMAIL`, `PASSWORD`, `TOKEN`, `FOLDER_ID`
3. Run `node server/test-browsers.cjs` — CDP must return port
4. `GET /api/health` → `ok`

### Phase B — Traffic source truth (one by one)
For profile `40cdcf7b-dc4d-4a04-8687-268e473ebc0f` + test video:

| Order | Source | Pass criteria |
|-------|--------|---------------|
| 1 | `google` | Log: `[Traffic] Opened via: google` + `watched: 1` |
| 2 | `bing` | Same for bing |
| 3 | `duckduckgo` | Same |
| 4 | `yahoo` | Same |
| 5 | `youtube-search` | Same |
| 6 | `direct` | `Opened via: direct` |

Command template:
```bash
node server/scripts/e2e-traffic-qa.cjs --profileId=UUID --name=P-351 \
  --title="..." --url="https://www.youtube.com/watch?v=..." \
  --channel="USA INSURANCE" --sources=google
```

E2E now fails if fallback used (strict QA).

### Phase C — `searchEngine.cjs` hardening
- VideoId match in Google/Bing results
- Consent overlays all engines
- Yahoo promo dismiss

### Phase D — `agent.cjs` watch polish
- QA cap 120–180s for E2E; 10–15 min for manual runs
- Engagement order: ads → duration → scroll → seek → like → comment

### Phase E — Full regression
- All sources in one serial run (~30–45 min with caps)
- Activity Logs export JSON
- Dashboard analytics match worker counts

---

## 7. Success definition (sab kuch sahi)

```
✅ Multilogin start/stop reliable
✅ Each traffic source: Opened via: {source} (no silent direct-fallback in QA)
✅ Verify confirms correct video
✅ Watch ≥ qaMinWatchSec with scroll/seek/like/comment logs
✅ Profile stops after job
✅ E2E: 6/6 PASS on P-351
```

When Phase E passes → **poora server pipeline sahi**.

---

## 8. Quick reference — who calls whom

```
index.cjs
  └─ orchestrator.runSchedule()
       └─ worker.cjs (thread)
            ├─ ProviderFactory → MultiloginProvider
            └─ ProfileAgent (agent.cjs)
                 ├─ openVideoSmart / openVideoViaBacklink (searchEngine.cjs)
                 ├─ detectPageBlock / verifyOpenedVideo (agentBrain.cjs)
                 ├─ recoverProfile (profileRecovery.cjs) [on block]
                 └─ watchVideo / handleAds / engagement
                      └─ logs → worker → orchestrator.onActivityLog → activityLog.cjs
```

---

*Document version: 2026-05-20 — planning only, implementation follows phases A→E.*

---

## 9. Watch behavior — requirements vs files (user spec)

### 9.1 Requirement checklist

| Requirement | Primary file | Status |
|-------------|--------------|--------|
| Autoplay OFF har video | `agent.cjs` → `disableAutoplay()` | ⚠️ Code hai; mobile/silent fail ho sakta hai |
| Quality = Profile Settings | `agent.cjs` → `setVideoQuality()` | ⚠️ Desktop OK; m.youtube weak |
| Watch time = settings jitna | `agent.cjs` + `agentBrain.buildAgentConfig` | ⚠️ **% range** (min–max), random %; QA cap alag |
| Scroll during play, human curves | `agent.cjs` `smoothScroll` + `agentBrain.planWatchAction` | ⚠️ Stepped+jitter, **per-profile seed nahi** |
| Ad skip ON/OFF + seconds from settings | `agent.cjs` `handleAds` + `watchVideo` | ✅ Mostly OK (`adSkipEnabled`, `adSkipAfterSec`) |
| Like ON → kare, OFF → na kare | `agent.cjs` `watchVideo` phase 3 | ⚠️ ON pe bhi **random 30% skip** |
| Dislike ON/OFF | `agent.cjs` phase 3 | ⚠️ ON pe random/QA only |
| Comment ON + text → kare | `agent.cjs` phase 5 | ⚠️ ON pe **random 20%** (QA force) |
| Subscribe ON/OFF | `agent.cjs` phase 4 | ⚠️ ON pe **random 30%**, session once |

### 9.2 Kaun si file kya karti hai (watch settings)

```
Profile Settings (UI) → schedule profileConfigs
        ↓
index.cjs          POST /api/schedule/run
        ↓
orchestrator.cjs   buildAgentConfig() per profileId → worker thread
        ↓
worker.cjs         passes config → ProfileAgent.searchAndWatch / watchByUrl
        ↓
agent.cjs          disableAutoplay, setVideoQuality, handleAds, watchVideo
        ↑
agentBrain.cjs     buildAgentConfig + planWatchAction (scroll timing)
```

**Orchestrator + worker** settings **apply** karte hain; **execute** `agent.cjs` karta hai.

### 9.3 Orchestrator / worker — “powerful” kya add karna hai (TODO)

| # | Task | File |
|---|------|------|
| 1 | Start se pehle config validate (watch min≤max, adSkip sec≥0) | `orchestrator.cjs` |
| 2 | Har profile ka full config log (traffic, watch%, adSkip, like…) | `worker.cjs` |
| 3 | `profileId` se scroll personality seed (har profile alag curve/range) | `agentBrain.cjs` + `agent.cjs` |
| 4 | Engagement: ON = **must attempt** (no random skip); OFF = **never** | `agent.cjs` |
| 5 | Watch loop exit = exactly `durationMs` (ads excluded) | `agent.cjs` (already tries) |
| 6 | Fail job if autoplay/quality verify fail (optional strict mode) | `agent.cjs` |

### 9.4 Abhi baki (notes)

- Per-profile scroll **deterministic alag** — ab sirf `Math.random()` hai
- **Bezier / curved** mouse path — ab chhoti steps + jitter (`smoothScroll`)
- Watch time UI **percentage** hai, seconds nahi — user ko clear karna
- `qaTestMode` production schedule mein off rehna
- Mobile autoplay/quality/like selectors alag DOM
- Traffic sources (Google etc.) — alag track, watch behavior se independent
