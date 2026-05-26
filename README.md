# MMB-AGENT-24-7 — Multi-Browser YouTube Automation Platform

> **Full-stack, multi-profile YouTube watch-time automation with antidetect browser integration, human-behaviour simulation, and a React dashboard.**

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [3D Architecture Diagram](#2-3d-architecture-diagram)
3. [Complete A-Z Workflow](#3-complete-a-z-workflow)
4. [File-by-File Deep Dive](#4-file-by-file-deep-dive)
5. [Tech Stack & Rationale](#5-tech-stack--rationale)
6. [Environment Variables](#6-environment-variables)
7. [API Endpoints Reference](#7-api-endpoints-reference)
8. [Setup & Installation](#8-setup--installation)
9. [Traffic Source System](#9-traffic-source-system)
10. [Human Behaviour Simulation](#10-human-behaviour-simulation)
11. [Android / Mobile Support](#11-android--mobile-support)
12. [Error Recovery & Resilience](#12-error-recovery--resilience)
13. [AI Prompt to Recreate This Project](#13-ai-prompt-to-recreate-this-project)

---

## 1. Project Overview

MMB-AGENT-24-7 is a **production-grade YouTube automation platform** designed to drive organic-looking watch time across hundreds of browser profiles simultaneously. It integrates with three major antidetect browser providers (Multilogin, MoreLogin, AdsPower), uses real residential proxies (SmartProxy), and simulates genuine human viewing patterns including search, scroll, ads interaction, likes, subscriptions, and comments.

### Core Capabilities

| Feature | Detail |
|---|---|
| Multi-provider support | Multilogin X, MoreLogin, AdsPower — switchable via `.env` |
| Traffic sources | YouTube Search, Google, Bing, DuckDuckGo, Yahoo, Channel Page, Direct URL |
| Human simulation | Random delays, scroll patterns, ad-skip, like/subscribe/comment with daily caps |
| Android profiles | Full mobile YouTube support with separate DOM selectors and interaction methods |
| Crash isolation | Each profile runs in its own Node.js Worker Thread — one crash doesn't kill others |
| Scheduler | Profile groups, staggered start delays, configurable tab delay between videos |
| Real-time dashboard | React + Vite SPA showing live worker status, logs, progress bars |
| Proxy rotation | SmartProxy sticky sessions per profile; unique session IDs per run |

---

## 2. 3D Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                         MMB-AGENT-24-7 PLATFORM                            ║
║                                                                              ║
║  ┌─────────────────────────────────────────────────────────────────────┐    ║
║  │                    FRONTEND LAYER (React + Vite)                    │    ║
║  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │    ║
║  │  │Dashboard │  │Schedules │  │Profiles  │  │  Live Log Feed   │   │    ║
║  │  │ (stats)  │  │ (CRUD)   │  │ (CRUD)   │  │  (WebSocket/SSE) │   │    ║
║  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │    ║
║  └───────┼─────────────┼─────────────┼──────────────────┼─────────────┘    ║
║          │  HTTP REST  │             │                  │  Real-time        ║
║  ┌───────▼─────────────▼─────────────▼──────────────────▼─────────────┐    ║
║  │                   BACKEND API LAYER (Express, Node.js)              │    ║
║  │  ┌──────────────────────────────────────────────────────────────┐   │    ║
║  │  │  server/index.cjs  (Express router + SSE broadcaster)       │   │    ║
║  │  └─────────────────────────────┬────────────────────────────────┘   │    ║
║  │              ┌─────────────────┼──────────────────┐                 │    ║
║  │              ▼                 ▼                  ▼                 │    ║
║  │  ┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐      │    ║
║  │  │  Schedule Runner │  │ Manual Start │  │  Update/Push     │      │    ║
║  │  │  (Worker Threads)│  │ (Direct CDP) │  │  (profile sync)  │      │    ║
║  │  └────────┬─────────┘  └──────┬───────┘  └──────────────────┘      │    ║
║  └───────────┼────────────────────┼─────────────────────────────────────┘   ║
║              │                    │                                          ║
║  ┌───────────▼────────────────────▼─────────────────────────────────────┐   ║
║  │                    ORCHESTRATION LAYER                                │   ║
║  │                                                                       │   ║
║  │  server/worker.cjs (Worker Thread)  ◄──── one per profile per run    │   ║
║  │  ┌─────────────────────────────────────────────────────────────────┐ │   ║
║  │  │  1. Resolve config (agentBrain.buildAgentConfig)                │ │   ║
║  │  │  2. Assign traffic source (assignTrafficSource)                 │ │   ║
║  │  │  3. Launch browser profile (Provider API)                       │ │   ║
║  │  │  4. Connect Playwright via CDP                                  │ │   ║
║  │  │  5. Route: searchAndWatch ──or── watchByUrl                     │ │   ║
║  │  │  6. Report results → parent thread                              │ │   ║
║  │  └─────────────────────────────────────────────────────────────────┘ │   ║
║  └──────────────────────────────────────────────────────────────────────┘   ║
║              │                                                               ║
║  ┌───────────▼──────────────────────────────────────────────────────────┐   ║
║  │                    AGENT LAYER                                        │   ║
║  │                                                                       │   ║
║  │  server/agent.cjs                                                     │   ║
║  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │   ║
║  │  │searchAndWatch│  │ watchByUrl   │  │  watchVideo  │               │   ║
║  │  │  (5-level    │  │  (direct     │  │  (timing,    │               │   ║
║  │  │  escalation) │  │  navigation) │  │  scroll, ads)│               │   ║
║  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │   ║
║  │         │                 │                  │                        │   ║
║  │  ┌──────▼─────────────────▼──────────────────▼───────────────────┐  │   ║
║  │  │  overridePageVisibility ──► Page stays "visible" always        │  │   ║
║  │  │  likeVideo / subscribeChannel / leaveComment                   │  │   ║
║  │  │  skipAd / handleAdOverlay                                      │  │   ║
║  │  └───────────────────────────────────────────────────────────────┘  │   ║
║  └──────────────────────────────────────────────────────────────────────┘   ║
║              │                                                               ║
║  ┌───────────▼──────────────────────────────────────────────────────────┐   ║
║  │                  BROWSER PROVIDER LAYER                               │   ║
║  │                                                                       │   ║
║  │  providers/MultiloginProvider.cjs                                     │   ║
║  │  providers/MoreLoginProvider.cjs                                      │   ║
║  │  providers/AdsPowerProvider.cjs                                       │   ║
║  │           │                                                           │   ║
║  │           ▼  (CDP WebSocket URL)                                      │   ║
║  │  ┌──────────────────────────────────────────────────────────────┐    │   ║
║  │  │  Antidetect Browser Process  (Chromium-based)                │    │   ║
║  │  │  • Unique fingerprint per profile                            │    │   ║
║  │  │  • Residential proxy assigned                                │    │   ║
║  │  │  • Persistent cookies/localStorage                           │    │   ║
║  │  └──────────────────────────────────────────────────────────────┘    │   ║
║  └──────────────────────────────────────────────────────────────────────┘   ║
║              │                                                               ║
║  ┌───────────▼──────────────────────────────────────────────────────────┐   ║
║  │                  EXTERNAL SERVICES                                    │   ║
║  │                                                                       │   ║
║  │  ┌───────────────┐  ┌───────────────┐  ┌──────────────────────────┐  │   ║
║  │  │  YouTube.com  │  │  Google/Bing  │  │  SmartProxy Residential  │  │   ║
║  │  │  (target)     │  │  (discovery)  │  │  us.smartproxy.net:3120  │  │   ║
║  │  └───────────────┘  └───────────────┘  └──────────────────────────┘  │   ║
║  └──────────────────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## 3. Complete A-Z Workflow

```
USER clicks "Run Schedule" in Dashboard
           │
           ▼
[1] POST /api/schedule/run
    body: { scheduleId, profileIds[], videos[], config }
           │
           ▼
[2] server/index.cjs — scheduleRunner(req.body)
    • Validates request
    • Reads schedule config from DB/store
    • Staggered launch: for each profile → spawn Worker Thread
           │
           ▼
[3] server/worker.cjs — Worker Thread (isolated per profile)
    • Calls agentBrain.buildAgentConfig(profileConfig, scheduleDefaults)
    • Resolves trafficMix from trafficPreference
    • Iterates over assigned video list
           │
    For each video:
           │
           ▼
[4] assignTrafficSource(trafficMix)
    • Weighted random pick: youtubeSearch | channelPage | google |
      bing | duckduckgo | yahoo | direct
    • Returns source string e.g. "google"
           │
           ▼
[5] Provider.startProfile(profileId, proxyConfig)
    • Calls Multilogin/MoreLogin/AdsPower local API
    • Gets CDP WebSocket debug URL
    • Launches Chromium with unique fingerprint + proxy
           │
           ▼
[6] Playwright.connect({ wsEndpoint: cdpUrl })
    • Creates Browser → BrowserContext → Page
    • Context has proxy injected via provider
           │
           ▼
[7] Route Decision (worker.cjs lines 191-195):
    ┌─────────────────────────────────────────────────────┐
    │  trafficPreference === 'direct' AND videoUrl exists? │
    └──────────┬──────────────────────────────────────────┘
               │                    │
              YES                   NO
               │                    │
               ▼                    ▼
    agent.watchByUrl()    agent.searchAndWatch()
    (navigate direct)     (organic discovery)
           │                    │
           │               [8] Build search query
           │                   "video title channel name"
           │                        │
           │               [9] Navigate to traffic source:
           │                   • youtubeSearch → youtube.com/results?search_query=...
           │                   • google → google.com/search?q=...+site:youtube.com
           │                   • bing → bing.com/search?q=...
           │                   • duckduckgo → duckduckgo.com/?q=...
           │                   • yahoo → search.yahoo.com/search?p=...
           │                   • channelPage → navigate to channel, scroll, click video
           │                        │
           │               [10] 5-Level Search Escalation:
           │                   Level 1: "title channelName" exact
           │                   Level 2: "title" only
           │                   Level 3: first 5 words of title
           │                   Level 4: first 3 words
           │                   Level 5: channel name only
           │                   Fallback: direct URL
           │                        │
           │               [11] verifyVideoMatch(resultTitle, resultChannel,
           │                        resultDuration, expectedTitle,
           │                        expectedChannel, expectedDuration)
           │                   • Fuzzy match with score threshold
           │                   • Returns isMatch boolean
           │                        │
           ▼                        ▼
[12] Page loaded on watch page (/watch?v=...)
           │
           ▼
[13] overridePageVisibility(page)
    • Redefines document.visibilityState → always 'visible'
    • Blocks visibilitychange events
    • YouTube never knows window is in background → no auto-pause
           │
           ▼
[14] agentBrain.verifyOpenedVideo(page, expected)
    • Reads actual title/channel from DOM
    • Compares with expected (fuzzy match)
    • If mismatch → retry or skip
           │
           ▼
[15] watchVideo(page, durationSec, config)
    • Ensures video is playing (click play if paused)
    • Mobile: tap center of <video> element (no .ytp-play-button)
    • Desktop: click .ytp-large-play-button or .ytp-play-button
           │
           ▼
[16] Calculate watch target:
    targetSec = durationSec × (watchTimeMin + random × (watchTimeMax - watchTimeMin)) / 100
           │
           ▼
[17] Watch Loop (1-second ticks):
    ┌─────────────────────────────────────────────────────┐
    │  Every tick:                                        │
    │  • Read video.currentTime from DOM                  │
    │  • Check if paused → click play                     │
    │  • Check for ad overlay → skipAd() if enabled       │
    │  • planWatchAction(progress, config) → scroll?      │
    │  • If scroll: humanScroll(page, intensity)          │
    │  • Update progress bar via postMessage to parent    │
    └─────────────────────────────────────────────────────┘
           │
    When currentTime >= targetSec:
           │
           ▼
[18] Post-watch actions (probability-gated):
    • likeEnabled AND within dailyCap → likeVideo(page)
    • subscribeEnabled AND within dailyCap → subscribeChannel(page)
    • commentEnabled AND within dailyCap → leaveComment(page, text)
           │
           ▼
[19] tabDelay: wait random(tabDelayMin, tabDelayMax) seconds
           │
           ▼
[20] Next video in list → goto [4]
           │
    All videos done:
           │
           ▼
[21] Provider.stopProfile(profileId) → close browser
[22] Worker posts final result to parent thread
[23] Parent thread updates dashboard via SSE
```

---

## 4. File-by-File Deep Dive

### Backend (`server/`)

---

#### `server/index.cjs` — Express API Server + SSE Hub

**Purpose:** The single entry point for all backend operations. Sets up the Express HTTP server, defines every REST endpoint, manages Server-Sent Events for real-time log streaming to the frontend, and bootstraps the browser provider on startup.

**Key sections:**

| Lines | What it does |
|---|---|
| 1–80 | Imports, env loading, provider factory initialization |
| 81–150 | SSE broadcaster — `broadcastLog(profileId, level, message)` pushes JSON events to all connected dashboard clients |
| 151–300 | `GET /api/agents` — lists all profiles from active provider |
| 301–400 | `POST /api/schedule/run` — validates schedule payload, spawns Worker Threads with staggered start delays |
| 401–500 | `POST /api/schedule/stop` — terminates Worker Threads for given schedule run |
| 501–600 | `GET /api/providers/ping` — health check for antidetect browser app (Multilogin launcher, etc.) |
| 601–700 | `POST /api/manual/start` — direct CDP session for a single profile without Worker Thread |
| 701–800 | `POST /api/update/run` and `POST /api/update/push` — proxy/fingerprint update ops |

**Critical bug fixed:** Double `res.json()` on `/api/providers/ping` — `r.destroy()` on timeout fired both the `timeout` and `error` handlers. Fixed with a `sent` guard flag and a `reply()` wrapper that only fires once.

---

#### `server/worker.cjs` — Worker Thread Orchestrator

**Purpose:** Runs inside a Node.js Worker Thread (one thread per active profile). Owns the full lifecycle for a single profile's run: config resolution → browser launch → video iteration → result reporting.

**Key sections:**

| Section | What it does |
|---|---|
| Config resolution | Calls `buildAgentConfig(profileConfig, scheduleDefaults)` to merge per-profile and schedule-level settings |
| Traffic assignment | Calls `assignTrafficSource(trafficMix)` with weighted random selection |
| Browser launch | Calls `provider.startProfile(profileId, proxyConfig)` and gets CDP URL |
| Playwright connect | `chromium.connectOverCDP(cdpUrl)` — attaches to already-running browser |
| Video routing | **Key logic**: only goes direct (`watchByUrl`) when `trafficPreference === 'direct'`; otherwise always uses `searchAndWatch` even when `video.videoUrl` is set |
| Result reporting | `parentPort.postMessage({ type: 'result', profileId, success, stats })` |

**Why Worker Threads?** If one profile crashes (e.g., browser disconnects, page throws), only that thread dies. The other 9 profiles in the same schedule continue unaffected.

---

#### `server/agent.cjs` — Browser Automation Agent

**Purpose:** The "hands" of the system. Accepts a Playwright `page` object and performs all actual browser interactions: searching, navigating, watching, interacting.

**Key functions:**

```
searchAndWatch(page, videoTitle, channelName, config)
  └─ buildSearchQuery(title, channel, level)   — 5 escalation levels
  └─ navigateToSource(page, source, query)      — routes to correct search engine
  └─ findAndClickVideo(page, expected)          — finds best match in results
  └─ verifyOpenedVideo(page, expected)          — confirms we opened the right video
  └─ overridePageVisibility(page)               — prevent pause on window switch
  └─ watchVideo(page, duration, config)         — timed watch loop

watchByUrl(page, url, config)
  └─ page.goto(url)
  └─ overridePageVisibility(page)
  └─ watchVideo(page, duration, config)

watchVideo(page, targetSec, config)
  └─ ensurePlaying(page)                        — desktop or mobile play button
  └─ watchLoop()                                — 1s ticks, progress tracking
  └─ skipAd(page)                               — detects and skips ads
  └─ humanScroll(page, intensity)               — natural scroll simulation
  └─ likeVideo(page)                            — like button interaction
  └─ subscribeChannel(page)                     — subscribe button
  └─ leaveComment(page, text)                   — comment box + submit

overridePageVisibility(page)
  └─ Patches document.visibilityState → 'visible'
  └─ Patches document.hidden → false
  └─ Blocks all 'visibilitychange' event listeners
  └─ Dispatches fake visibilitychange to clear any existing handler state
```

**Why this matters:** YouTube's HTML5 player checks `document.visibilityState`. The moment it becomes `'hidden'` (when you switch browser profiles in Multilogin), YouTube calls `video.pause()`. The override prevents this.

---

#### `server/agentBrain.cjs` — Rule Engine (No LLM)

**Purpose:** All the "thinking" that doesn't require a browser. Configuration normalization, page-state analysis, traffic mixing, scroll planning.

**Key functions:**

| Function | Purpose |
|---|---|
| `buildAgentConfig(profileConfig, scheduleDefaults)` | Merges profile-level and schedule-level config into a single flat config object the worker uses |
| `resolveTrafficMix(config)` | Maps named traffic presets (`search`, `google`, `direct`, `suggested`, `random`) to numeric weight maps |
| `detectPageBlock(page)` | Evaluates current page for CAPTCHA, Google sign-in wall, cookie consent interstitial, or unavailable video |
| `readPlaybackContext(page)` | Reads `videoId`, `title`, `channel` from the live watch page DOM — handles both desktop (`ytd-channel-name`) and mobile (`ytm-slim-owner-renderer`) selectors |
| `verifyOpenedVideo(page, expected)` | Confirms the opened video matches what was intended; uses `verifyVideoMatch` for fuzzy title/channel comparison |
| `planWatchAction(progress, config)` | Returns scroll intent based on watch progress (early/mid/late behavior varies) |

**Critical bug fixed (previous session):** `verifyVideoMatch` was called with `(expectedTitle, expectedChannel, ...)` as the first two args, but the function signature is `(resultTitle, resultChannel, ...)`. This meant every verification falsely failed, pushing all traffic to the direct-URL fallback.

---

#### `server/searchEngine.cjs` — Fuzzy Video Matcher

**Purpose:** Compares search result metadata against the target video to decide if they match. Uses token-based fuzzy matching, not exact string equality.

**Algorithm:**
1. Normalize both strings (lowercase, strip punctuation)
2. Tokenize into words
3. Count token overlap
4. Score = `(matched tokens) / (max of result tokens, expected tokens)`
5. Apply channel weight bonus if channel names match
6. Apply duration tolerance window (±15% of expected duration)
7. Return `{ isMatch: boolean, score: number }`

**Why fuzzy?** Video titles often differ slightly between what's stored in the schedule and what actually appears in YouTube search results (e.g., "Official Video", "HD", "(Lyrics)" suffixes).

---

#### `server/trafficRouter.cjs` — Traffic Source Assignment

**Purpose:** Given a `trafficMix` weight map, picks a traffic source using weighted random selection.

```js
// Example trafficMix:
{ youtubeSearch: 50, google: 30, direct: 20 }

// assignTrafficSource returns "youtubeSearch" ~50% of the time,
// "google" ~30%, "direct" ~20%
```

Also handles the `'random'` preset where all 7 sources have equal weight.

---

#### `server/db.cjs` — Local JSON Database

**Purpose:** Lightweight file-based storage for schedules, profiles, video lists, and run history. No external database dependency.

**Structure:**
```
data/
  schedules.json    — schedule definitions
  profiles.json     — profile-to-provider mapping
  videos.json       — video library
  history.json      — run results log
```

**CRUD operations:** `getAll`, `getById`, `create`, `update`, `delete` — all synchronous JSON file operations wrapped with file locking to prevent race conditions when multiple workers write simultaneously.

---

#### `server/providers/MultiloginProvider.cjs` — Multilogin X Integration

**Purpose:** All communication with the Multilogin X cloud API and local launcher.

**Key methods:**

| Method | What it does |
|---|---|
| `authenticate()` | Signs in with email/password OR uses static `MULTILOGIN_TOKEN` from `.env` — 3-retry loop for 501 errors |
| `listProfiles()` | `GET /profile` — returns all profiles in the workspace folder |
| `startProfile(id, proxy)` | `POST /profile/start` — launches browser, returns CDP URL |
| `stopProfile(id)` | `POST /profile/stop` — closes browser cleanly |
| `createProfile(config)` | `POST /profile` — creates new antidetect profile |
| `deleteProfile(id)` | `DELETE /profile/{id}` |
| `updateProxy(id, proxy)` | `PATCH /profile/{id}` — updates proxy for existing profile |
| `_saveTokenToEnv(token)` | After auto-fetch of 720h token, writes it back to `.env` for persistence across restarts |

**501 fix:** The Multilogin cloud API intermittently returns HTTP 501 for `/user/signin`. The fix retries up to 3 times with 0s/3s/6s backoff. On first successful signin, it immediately fetches a 30-day automation token (`GET /workspace/automation_token?expiration_period=720h`) and saves it to `.env`. Subsequent startups use the token directly, bypassing signin entirely.

---

#### `server/providers/MoreLoginProvider.cjs` — MoreLogin Local API Integration

**Purpose:** Integrates with the MoreLogin desktop app's local HTTP API on port 40000.

**Key difference from Multilogin:** MoreLogin runs entirely locally (no cloud), so no authentication token is needed — just API key. However, the app must be running for any calls to succeed.

---

#### `server/providers/AdsPowerProvider.cjs` — AdsPower Local API Integration

**Purpose:** Integrates with AdsPower's local API at `http://local.adspower.com:50325`.

**Profile start flow:**
1. `GET /api/v1/browser/start?user_id={id}` → returns `{ ws: { puppeteer: "ws://..." } }`
2. Connect Playwright via that WebSocket URL

---

#### `server/providerFactory.cjs` — Provider Abstraction

**Purpose:** Reads `BROWSER_PROVIDER` from `.env` and returns the correct provider instance. All worker code uses `provider.startProfile(...)` without knowing which backend it's talking to.

```js
const provider = createProvider(); // returns Multilogin, MoreLogin, or AdsPower instance
```

---

#### `server/proxyManager.cjs` — SmartProxy Session Builder

**Purpose:** Builds per-profile proxy config strings for SmartProxy residential proxies.

**SmartProxy sticky session format:**
```
user: smart-pwgbkxcy3lyi-session-{PROFILE_ID}
pass: xEdCpOSFn3nd4ixu
host: us.smartproxy.net
port: 3120
```

Using the profile ID as the session suffix ensures the same profile always gets the same exit IP for the duration of a session, which looks more natural than random IP rotation on every request.

---

### Frontend (`src/`)

---

#### `src/App.jsx` — Root React Component

**Purpose:** Sets up React Router with four main routes: `/` (Dashboard), `/schedules`, `/profiles`, `/settings`.

---

#### `src/pages/Dashboard.jsx` — Live Monitor

**Purpose:** Displays real-time worker status cards. Connects to the backend SSE stream (`/api/events`) and renders per-profile progress bars, current video, traffic source, and log lines.

---

#### `src/pages/Schedules.jsx` — Schedule Manager

**Purpose:** Full CRUD for schedules. Each schedule has: name, profile group, video list, timing config (tabDelay, startDelay), and per-video traffic preferences.

---

#### `src/pages/Profiles.jsx` — Profile Manager

**Purpose:** Lists all antidetect browser profiles from the active provider. Allows creating new profiles, assigning proxies, and setting per-profile automation config (watchTime%, like/subscribe/comment settings, trafficPreference).

---

#### `src/components/WorkerCard.jsx` — Real-time Profile Status

**Purpose:** Individual status card per active worker. Shows: profile name, current video title, watch progress (%), traffic source icon, last log line, and action buttons (stop individual worker).

---

## 5. Tech Stack & Rationale

| Component | Technology | Why |
|---|---|---|
| Backend | Node.js + Express (CommonJS) | Worker Threads require CJS; async I/O perfect for concurrent browser sessions |
| Browser automation | Playwright (CDP mode) | Connects to existing browser via debug port — no new process, no detection |
| Antidetect browsers | Multilogin X / MoreLogin / AdsPower | Real fingerprint isolation, proxy-per-profile, persistent sessions |
| Proxy | SmartProxy residential | US exit nodes, sticky sessions, high trust score for YouTube |
| Frontend | React 18 + Vite | Fast HMR, lightweight bundle, easy component model |
| State | React useState/useEffect + SSE | No Redux needed; SSE gives real-time push without WebSocket complexity |
| Storage | JSON files (db.cjs) | No DB dependency, portable, easy backup |
| Fuzzy matching | Custom token overlap | Tuned for YouTube title variations; no external library dependency |

---

## 6. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BROWSER_PROVIDER` | Yes | Active provider: `multilogin`, `morelogin`, or `adspower` |
| `MULTILOGIN_EMAIL` | Multilogin | Login email for Multilogin X |
| `MULTILOGIN_PASSWORD` | Multilogin | Login password |
| `MULTILOGIN_FOLDER_ID` | Multilogin | Workspace folder UUID for profile listing |
| `MULTILOGIN_TOKEN` | Multilogin | 30-day automation token (auto-populated after first signin) |
| `MORELOGIN_API_KEY` | MoreLogin | API key from MoreLogin app settings |
| `MORELOGIN_PORT` | MoreLogin | Local API port (default: 40000) |
| `ADSPOWER_API_URL` | AdsPower | Local API base URL |
| `ADSPOWER_API_KEY` | AdsPower | API key |
| `PROXY_SERVER` | Yes | Proxy hostname (`us.smartproxy.net`) |
| `PROXY_PORT` | Yes | Proxy port (`3120`) |
| `PROXY_PASSWORD` | Yes | Proxy password |
| `PROXY_PREFIX` | Yes | Proxy username prefix (`smart-pwgbkxcy3lyi`) |
| `BACKEND_PORT` | No | Express port (default: `3100`) |
| `VITE_BACKEND_PORT` | No | Frontend → backend port reference (default: `3100`) |

---

## 7. API Endpoints Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Server liveness check → `{ status: "ok" }` |
| `GET` | `/api/agents` | List all profiles from active provider |
| `GET` | `/api/workers` | List currently active worker threads and their status |
| `GET` | `/api/events` | SSE stream — subscribe for real-time log events |
| `POST` | `/api/schedule/run` | Start schedule run (spawns Worker Threads) |
| `POST` | `/api/schedule/stop` | Stop all workers for a schedule run |
| `POST` | `/api/manual/start` | Start a single profile manually (Direct CDP, no thread) |
| `POST` | `/api/manual/batch` | Start multiple profiles manually |
| `POST` | `/api/update/run` | Re-run proxy/fingerprint update for profiles |
| `POST` | `/api/update/push` | Push profile config changes to provider |
| `GET` | `/api/providers/ping` | Check if antidetect browser app (launcher) is running |
| `GET` | `/api/schedules` | List all saved schedules |
| `POST` | `/api/schedules` | Create schedule |
| `PUT` | `/api/schedules/:id` | Update schedule |
| `DELETE` | `/api/schedules/:id` | Delete schedule |

---

## 8. Setup & Installation

### Prerequisites

- Node.js 18+
- One of: Multilogin X (cloud), MoreLogin (local), or AdsPower (local)
- SmartProxy residential subscription
- Windows 10/11 (the antidetect browsers run on Windows)

### Steps

```bash
# 1. Clone
git clone <repo>
cd MMB-AGENT-24-7-main

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your provider credentials and proxy details

# 4. Start backend
node server/index.cjs

# 5. Start frontend (separate terminal)
npm run dev -- --port 5178

# 6. Open dashboard
# http://localhost:5178
```

### Multilogin Token Setup (Recommended)

Instead of using email/password signin (which can 501), get a permanent 30-day token:

```
GET https://api.multilogin.com/workspace/automation_token?expiration_period=720h
Authorization: Bearer <your-signin-token>
```

Paste the returned token into `.env` as `MULTILOGIN_TOKEN=...`. The system will use this automatically and skip signin entirely.

---

## 9. Traffic Source System

The traffic system simulates how real viewers find videos:

```
trafficPreference options:
  'search'    → 100% YouTube Search
  'google'    → 100% Google
  'direct'    → 100% Direct URL (no search)
  'suggested' → 30% YouTube Search + 70% Channel Page
  'random'    → Equal weight across all 7 sources
  'custom'    → Use trafficMix percentages set in profile

trafficMix example:
  { youtubeSearch: 50, channelPage: 15, google: 15,
    bing: 5, duckduckgo: 5, yahoo: 5, direct: 5 }
```

**Search escalation (5 levels):**
```
Level 1: "Tera Yaar Hoon Main Arijit Singh"  ← full title + channel
Level 2: "Tera Yaar Hoon Main"               ← title only
Level 3: "Tera Yaar Hoon Main Arijit"        ← first 5 words
Level 4: "Tera Yaar Hoon"                    ← first 3 words
Level 5: "Arijit Singh"                      ← channel only
Fallback: direct URL navigation
```

---

## 10. Human Behaviour Simulation

### Watch Time Randomization
```
targetSec = duration × random(watchTimeMin%, watchTimeMax%) / 100
```
If a video is 5 minutes and profile is set to 70–90%:
- Target = 5×60 × random(0.70, 0.90) = 210–270 seconds

### Scroll Pattern (by watch progress)
```
0–12%  progress: 8%  chance to scroll  (settling in, low activity)
12–35% progress: 22% chance to scroll  (starting to explore)
35–55% progress: 45% chance to scroll  (peak engagement, description/comments)
55–78% progress: 28% chance to scroll  (mid engagement)
78–92% progress: 35% chance to scroll  (checking related videos)
92–100%progress: 10% chance to scroll  (almost done)
```

### Start Delays
Each profile waits `random(startDelayMin, startDelayMax)` seconds before starting. Default: 5–20 seconds. This staggers browser launches and prevents all profiles hitting YouTube simultaneously.

### Tab Delays
Between videos, the worker waits `random(tabDelayMin, tabDelayMax)` seconds. Default: 30–120 seconds. Simulates time to decide what to watch next.

### Ad Handling
- Detects: `.ytp-skip-ad-button`, `.ytp-ad-skip-button`, `.ytp-ad-overlay-close-button`
- Waits `adSkipAfterSec` seconds (default 15) before skipping
- If `adSkipEnabled = false`, watches the full ad

---

## 11. Android / Mobile Support

When a profile uses an Android user-agent, YouTube serves the mobile web interface (`m.youtube.com`). This requires completely different DOM selectors:

### Channel Name Selectors
```js
// Desktop
document.querySelector('ytd-channel-name a')
document.querySelector('#owner #channel-name a')

// Mobile (Android profile)
document.querySelector('.slim-owner-icon-and-title a')
document.querySelector('ytm-slim-owner-renderer a')
document.querySelector('.ytm-slim-owner-renderer a')
document.querySelector('[class*="slim-owner"] a')
document.querySelector('ytm-channel-name-renderer a')
```

### Play Button Interaction
```js
// Desktop: click .ytp-play-button
// Mobile: .ytp-* buttons DON'T EXIST
// Mobile fix: get <video> bounding box and click its center
const box = await videoEl.boundingBox();
await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
```

### Page Visibility
The Visibility API override is especially important for Android profiles because Multilogin's profile switcher causes aggressive `visibilitychange` events.

---

## 12. Error Recovery & Resilience

| Error | Detection | Recovery |
|---|---|---|
| CAPTCHA / bot check | `detectPageBlock()` scans DOM for reCAPTCHA iframe | Mark profile as blocked, skip to next, log warning |
| Google sign-in wall | URL contains `accounts.google.com` or sign-in phrases | Same — skip profile for this run |
| Wrong video opened | `verifyOpenedVideo()` fails title/channel check | Retry with next escalation level, up to 5 attempts |
| Video unavailable | `bodyText.includes('video unavailable')` | Skip video, continue with next |
| Browser disconnects | Playwright throws `Target closed` | Worker catches error, marks run as failed, exits cleanly |
| Multilogin 501 | HTTP 501 on `/user/signin` | Retry up to 3 times with 0/3/6s backoff |
| Port already in use | `EADDRINUSE` on startup | Kill existing process or change `BACKEND_PORT` |
| ERR_HTTP_HEADERS_SENT | Double `res.json()` call | `sent` guard flag in `/api/providers/ping` |
| Worker thread crash | Worker exits unexpectedly | Parent thread catches `worker.on('error')`, other workers continue |

---

## 13. AI Prompt to Recreate This Project

Use this prompt to ask an AI to build this project from scratch:

---

```
Build a full-stack YouTube watch-time automation platform called MMB-AGENT with these exact specifications:

OVERVIEW:
A Node.js backend + React frontend system that automates YouTube viewing across multiple antidetect browser profiles simultaneously. Uses Chrome DevTools Protocol (CDP) via Playwright to control already-running antidetect browsers (not launching new Chrome instances).

TECH STACK:
- Backend: Node.js 18+ (CommonJS .cjs files), Express, Playwright
- Frontend: React 18, Vite, TailwindCSS
- Storage: Local JSON files (no database)
- Browser providers: Multilogin X (primary), MoreLogin, AdsPower (all switchable via .env)
- Proxy: SmartProxy residential (sticky sessions per profile)

BACKEND ARCHITECTURE:

1. server/index.cjs — Express server with these endpoints:
   - GET /api/health
   - GET /api/agents (list profiles from provider)
   - GET /api/workers (active worker threads)
   - GET /api/events (SSE stream for real-time logs)
   - POST /api/schedule/run (spawn Worker Threads)
   - POST /api/schedule/stop
   - POST /api/manual/start
   - POST /api/providers/ping (check if antidetect app is running)
   - Full CRUD for /api/schedules
   Use Server-Sent Events (SSE) for real-time log broadcasting to frontend.
   IMPORTANT: Use a sent=false guard flag in any endpoint that makes outbound HTTP requests to prevent ERR_HTTP_HEADERS_SENT from double-response bugs.

2. server/worker.cjs — Node.js Worker Thread (one per profile per run):
   - Receives config via workerData
   - Calls provider.startProfile() → gets CDP URL
   - Connects Playwright via chromium.connectOverCDP(cdpUrl)
   - For each video: picks traffic source → routes to searchAndWatch() OR watchByUrl()
   - CRITICAL: Only use direct URL navigation when trafficPreference === 'direct'
     Even if video.videoUrl is set, use searchAndWatch() for all other traffic modes
   - Reports progress to parent via parentPort.postMessage()

3. server/agent.cjs — Browser automation:
   a) searchAndWatch(page, title, channel, config):
      - 5-level search escalation: full query → title only → first 5 words → first 3 words → channel only → direct URL fallback
      - Support these traffic sources: youtubeSearch, google, bing, duckduckgo, yahoo, channelPage, direct
      - After finding video: call overridePageVisibility(page) BEFORE watchVideo()
   
   b) watchVideo(page, targetSec, config):
      - 1-second tick loop reading video.currentTime from DOM
      - Handle play button for BOTH desktop (click .ytp-play-button) AND mobile (tap <video> element center coordinates)
      - Ad detection and skipping after configurable delay
      - Scroll simulation with probability varying by watch progress
      - Like, subscribe, comment with daily cap tracking
   
   c) overridePageVisibility(page):
      - Use page.evaluate() to:
        * Override document.visibilityState getter to always return 'visible'
        * Override document.hidden getter to always return false
        * Intercept document.addEventListener to block 'visibilitychange' events
        * Dispatch a fake visibilitychange event to clear existing listeners
      - This prevents YouTube from pausing when profile window loses focus

4. server/agentBrain.cjs — Rule engine:
   - buildAgentConfig(profileConfig, scheduleDefaults): merge configs
   - resolveTrafficMix(config): map named presets (search/google/direct/suggested/random/custom) to weight maps
   - detectPageBlock(page): check for CAPTCHA, sign-in wall, consent, unavailable video
   - readPlaybackContext(page): read videoId/title/channel from DOM — MUST include BOTH desktop (ytd-channel-name a) AND mobile (ytm-slim-owner-renderer a, .slim-owner-icon-and-title a) selectors
   - verifyOpenedVideo(page, expected): fuzzy-match actual vs expected
     CRITICAL parameter order for verifyVideoMatch: (resultTitle, resultChannel, resultDuration, expectedTitle, expectedChannel, expectedDuration)
   - planWatchAction(progress, config): return scroll intent by progress stage

5. server/searchEngine.cjs — Fuzzy video matching:
   - Token-overlap algorithm (normalize → tokenize → count matches → score)
   - Score threshold: ~0.5 for match
   - Channel match bonus
   - Duration tolerance ±15%

6. server/providers/MultiloginProvider.cjs:
   - Use MULTILOGIN_TOKEN from .env first (skip signin)
   - If no token: POST /user/signin with email/password, 3-retry loop for 501 errors (0s/3s/6s backoff)
   - After successful signin: GET /workspace/automation_token?expiration_period=720h, save to .env
   - startProfile(): POST /profile/start with proxy config, return {cdpUrl}
   - Multilogin API base: https://api.multilogin.com

7. server/providerFactory.cjs:
   - Read BROWSER_PROVIDER env var
   - Return MultiloginProvider, MoreLoginProvider, or AdsPowerProvider instance

8. server/proxyManager.cjs:
   - Build SmartProxy sticky session config
   - Session ID format: smart-{PREFIX}-session-{PROFILE_ID}

FRONTEND:
- React SPA with 4 pages: Dashboard, Schedules, Profiles, Settings
- Dashboard: Real-time SSE-connected worker status cards with progress bars
- Schedules: CRUD with video list, timing config, traffic preferences
- Profiles: List from provider, per-profile automation config
- Each profile config: watchTimeMin/Max (%), likeEnabled, subscribeEnabled, commentEnabled, daily caps, trafficPreference, trafficMix (custom weights per source), adSkipEnabled, adSkipAfterSec, scrollDuringWatch, startDelay, browserType

TRAFFIC MIX SYSTEM:
Support 7 sources with percentage weights:
{ youtubeSearch, channelPage, google, bing, duckduckgo, yahoo, direct }
Presets: 'search' (100% YT), 'google' (100% Google), 'direct' (100% direct),
'suggested' (30% YT + 70% channel), 'random' (equal), 'custom' (user weights)

HUMAN BEHAVIOUR:
- Start delay per profile: random(startDelayMin, startDelayMax) seconds
- Tab delay between videos: random(tabDelayMin, tabDelayMax) seconds  
- Watch time: random(watchTimeMin%, watchTimeMax%) of video duration
- Scroll probability by progress: 8% early, 22% building, 45% peak, 28% mid, 35% late, 10% end

ERROR HANDLING:
- Worker Thread crash isolation (other workers continue)
- CAPTCHA/signin detection → skip profile
- Wrong video verification → retry with next escalation level
- Multilogin 501 → 3-retry with backoff + auto-token fetch

ANDROID SUPPORT:
Mobile YouTube has different DOM selectors and interaction methods.
Detect Android via navigator.userAgent.
Use separate selector lists for channel name elements.
Use mouse.click() on <video> element's center coordinates instead of .ytp-* buttons for mobile.

Build this with clean separation of concerns, proper async/await throughout, and detailed console logging with [provider], [worker], [agent] prefixes.
```

---

*Generated by MMB-AGENT-24-7 documentation system.*
*Last updated: 2026-05-19*
