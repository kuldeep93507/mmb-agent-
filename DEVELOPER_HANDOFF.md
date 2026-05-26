# MMB-AGENT-24-7 — Developer Handoff Document
## Complete Project Guide for New Developer

---

## 📋 PROJECT OVERVIEW

Ye ek **YouTube + Blog Traffic Automation Tool** hai. 2 tools hain:

1. **YouTube Tool** (root folder) — YouTube pe views, likes, subscribes, comments automate karta hai
2. **Sites Tool** (`MMB AGENT SITES/` folder) — Blog/website pe organic traffic generate karta hai

Dono tools same architecture use karte hain:
- Frontend: React + TypeScript + Tailwind + Vite
- Backend: Node.js + Express + Worker Threads
- Browser Automation: Playwright CDP → MoreLogin Anti-detect Browser
- Proxy: Smartproxy Residential (unique IP per profile)

---

## 🏗️ ARCHITECTURE

```
User Browser (React UI)
    ↓ (Vite Proxy)
Backend (Express Server)
    ↓
Orchestrator → Worker Threads (1 per profile)
    ↓
ProfileAgent → Playwright CDP → MoreLogin Browser
    ↓
YouTube/Blog → Watch/Read with human-like behavior
```

---

## 📁 FOLDER STRUCTURE

```
MMB-AGENT-24-7/
├── src/                    ← YouTube Tool Frontend
│   ├── App.tsx
│   ├── components/         ← 27 React components
│   ├── services/           ← API services (moreloginApi, backendApi, notifications, updateChecker)
│   ├── store/              ← State management (useStore, useChannelStore)
│   ├── types/              ← TypeScript types
│   └── utils/              ← Helpers (cn, generators)
├── server/                 ← YouTube Tool Backend
│   ├── index.cjs           ← Express server (port 3100)
│   ├── agent.cjs           ← Playwright CDP agent (human-like YouTube watching)
│   ├── orchestrator.cjs    ← Worker thread manager
│   └── worker.cjs          ← Worker thread (runs inside thread)
├── MMB AGENT SITES/        ← Sites Tool (separate project)
│   ├── src/                ← Sites Frontend (same structure as YouTube)
│   ├── server/             ← Sites Backend (port 3200)
│   ├── vite.config.ts      ← Vite config (port 5200, sitemap proxy)
│   └── package.json
├── vite.config.ts          ← YouTube Vite config (port 5178, YouTube/MoreLogin proxy)
├── package.json
├── version.json
└── watch_history.json      ← Backend watch history (auto-created)
```

---

## 🚀 HOW TO RUN

### YouTube Tool:
```bash
cd "d:\Kiro\KIRO PROJECT\MMB-AGENT-24-7"
npm run dev          # Frontend on localhost:5178
node server/index.cjs  # Backend on localhost:3100
```

### Sites Tool:
```bash
cd "d:\Kiro\KIRO PROJECT\MMB-AGENT-24-7\MMB AGENT SITES"
npm run dev          # Frontend on localhost:5200
node server/index.cjs  # Backend on localhost:3200
```

### Requirements:
- Node.js 18+
- MoreLogin Desktop App running (port 40000)
- npm packages installed (`npm install` in both folders)

---

## 🟢 KYA KAAM KAR RAHA HAI (Working)

### YouTube Tool:
- ✅ Frontend UI (all 13+ pages)
- ✅ MoreLogin API integration (fetch/start/stop/create/delete profiles)
- ✅ Channel add via InnerTube API (all videos fetch)
- ✅ Video Shuffle (no overlap, 24h history)
- ✅ Scheduler (5-step wizard, create/save/edit)
- ✅ Manual Control (batch commands via CDP)
- ✅ Backend server with all routes
- ✅ Playwright CDP agent (search, watch, like, subscribe, comment)
- ✅ Traffic Router (Google/Direct/Suggested/Backlink/Random)
- ✅ Human-like behavior (smooth scroll, mouse move, typing delays)
- ✅ Warmup phase (homepage browse + shorts)
- ✅ Session persistence (same tab reuse)
- ✅ Watch history (file-based, 24h window)
- ✅ Scheduled timer (60s interval check, repeat support)
- ✅ Video play verification (30s interval auto-resume)
- ✅ Profile auto-close after schedule (RAM free)
- ✅ Git Push to GitHub
- ✅ Settings save to localStorage
- ✅ Error Boundary (no white screen crash)

### Sites Tool:
- ✅ Frontend UI (all 13 pages)
- ✅ MoreLogin API integration
- ✅ Sitemap XML fetch + parse (with namespace handling, sitemap index support)
- ✅ Article Shuffle
- ✅ Scheduler (4-step wizard)
- ✅ Manual Control
- ✅ Backend server with all routes
- ✅ Playwright CDP agent (butter smooth scroll, ad pause, traffic router)

---

## 🔴 KYA FIX KARNA BAAKI HAI

### Priority HIGH:
1. **API keys `.env` me daalo** — Abhi hardcoded hain 6 files me:
   - `vite.config.ts` (line 14) — MORELOGIN_API_KEY
   - `src/services/moreloginApi.ts` (line 7) — API_KEY
   - `server/index.cjs` (line 22) — MORELOGIN_API_KEY
   - Same 3 files in `MMB AGENT SITES/`
   - Fix: Create `.env` file, use `process.env.MORELOGIN_API_KEY` in backend, `import.meta.env.VITE_MORELOGIN_API_KEY` in frontend

2. **Proxy Health real banana** — Abhi random numbers generate karta hai. Fix: Backend pe actual proxy connection test karo (HTTP request through proxy, measure latency)

3. **Job Queue real banana** — Frontend me job add hota hai but actually kuch nahi hota. Fix: Job add hone pe backend ko bhejo, backend agent run kare

### Priority MEDIUM:
4. **Zustand state management** — Abhi `useStore()` normal hook hai. Agar koi child component me directly call kare toh alag copy milegi. Fix: `npm install zustand`, convert useStore to zustand store

5. **Button loading states** — Start Profile, Run Schedule pe double-click protection nahi hai. Fix: `useState(loading)` add karo, button disable karo jab tak response na aaye

6. **Backend authentication** — Koi bhi localhost pe API call kar sakta hai. Fix: Simple API token check middleware

7. **SQLite database** — Abhi sab localStorage + file me hai. Fix: `better-sqlite3` install karo, tables banao (profiles, jobs, history, settings)

### Priority LOW:
8. **Cookie/login state** — YouTube logged-in users ko alag treat karta hai. Abhi fresh session hai. MoreLogin handles this partially (cookies persist in profile)

9. **Bandwidth check** — 50 profiles ek saath start karne pe machine hang ho sakti hai. MAX_CONCURRENT = 5 set hai but frontend pe limit enforce nahi hai

10. **TypeScript strict mode** — Bahut jagah `any` type use hua hai. Proper interfaces define karne chahiye

---

## 🔧 KEY FILES TO UNDERSTAND

### YouTube Tool:
| File | Purpose |
|------|---------|
| `server/agent.cjs` | **MOST IMPORTANT** — Playwright CDP agent. Human-like YouTube watching. Traffic router, engagement, warmup, scroll behavior |
| `server/index.cjs` | Express backend — all API routes, schedule runner, manual control, analytics, watch history, timer |
| `server/orchestrator.cjs` | Worker thread manager — spawns/stops workers |
| `server/worker.cjs` | Runs inside worker thread — calls agent functions |
| `src/store/useStore.ts` | Frontend state — profiles, jobs, logs. MoreLogin API calls |
| `src/store/useChannelStore.ts` | Channel/video state — InnerTube API |
| `src/components/SchedulerPage.tsx` | 5-step wizard — most complex UI component |
| `src/components/ManualControlPage.tsx` | Real-time browser control via CDP |
| `vite.config.ts` | Vite proxy — forwards `/morelogin-api`, `/youtube-feed`, `/backend-api` |

### Sites Tool:
| File | Purpose |
|------|---------|
| `MMB AGENT SITES/server/agent.cjs` | Playwright CDP agent for article reading. Butter smooth scroll, ad detection |
| `MMB AGENT SITES/src/store/useSiteStore.ts` | Site/article state — sitemap fetch/parse |
| `MMB AGENT SITES/vite.config.ts` | Vite proxy — forwards `/sitemap-fetch`, `/morelogin-api`, `/backend-api` |

---

## 🌐 API ENDPOINTS

### YouTube Backend (localhost:3100):
```
GET  /api/health              — Server status
GET  /api/agents              — Active CDP agents
GET  /api/analytics           — View/watch stats
GET  /api/workers             — Worker thread statuses
GET  /api/history             — Watch history (all profiles)
GET  /api/history/:profileId  — Watch history (one profile)
POST /api/history/add         — Add to watch history
POST /api/history/check       — Check if video already watched (24h)
POST /api/schedule/run        — Run a schedule (starts workers)
POST /api/schedule/stop       — Stop all workers
POST /api/schedule/timer/set  — Set scheduled timer
GET  /api/schedule/timer/list — List scheduled timers
POST /api/manual/start        — Start profiles for manual control
POST /api/manual/batch        — Send batch command to profiles
POST /api/analytics/track     — Track an action
POST /api/update/run          — Git pull + npm install
POST /api/update/push         — Git commit + push
GET  /api/update/version      — Current version
```

### Sites Backend (localhost:3200):
```
GET  /health                  — Server status
GET  /api/analytics           — Read stats
POST /api/scheduler/run       — Run article reading schedule
POST /api/manual/start        — Start profiles for manual control
POST /api/manual/batch        — Send batch command
POST /api/analytics/track     — Track an action
POST /api/update/push         — Git push
GET  /api/update/version      — Version
POST /start                   — Start worker for profile
POST /stop                    — Stop worker
POST /stop-all                — Stop all
GET  /status                  — Worker statuses
GET  /logs                    — Worker logs
```

---

## ⚙️ VITE PROXY ROUTES

### YouTube (vite.config.ts):
- `/morelogin-api/*` → `http://127.0.0.1:40000/*` (MoreLogin Local API)
- `/youtube-feed?channel_id=X` → YouTube InnerTube API (all videos)
- `/youtube-playlist?list=X` → YouTube InnerTube API (playlist)
- `/backend-api/*` → `http://127.0.0.1:3100/*` (Backend)

### Sites (MMB AGENT SITES/vite.config.ts):
- `/morelogin-api/*` → `http://127.0.0.1:40000/*` (MoreLogin Local API)
- `/sitemap-fetch?url=X` → Fetches any sitemap URL (with redirect following, HTTPS support)
- `/backend-api/*` → `http://127.0.0.1:3200/*` (Backend)

---

## 🤖 AGENT BEHAVIOR (agent.cjs)

### YouTube Agent Flow:
1. Warmup: Homepage browse + optional Shorts (1-3)
2. Traffic Router decides how to reach video (Search/Direct/Google/Backlink/Suggested)
3. Search: Type query human-like → browse results (scroll up/down) → find matching title → click
4. Watch: Handle ads → ensure playing → 6-phase behavior (focus → mouse → comments scroll → hover → related peek → end)
5. Engagement: Like (70% chance) → Subscribe (30%) → Comment (20%)
6. Play verification: Every 30s check if video still playing, auto-resume if paused
7. Session persistence: Same tab reused for next video

### Sites Agent Flow:
1. Traffic Router (Google Search / Direct / Internal Link / Backlink)
2. Start delay (5-30s random per profile)
3. Butter smooth scroll (sine wave speed, unique per profile)
4. Ad detection: Pause 0.5-2s when ad in viewport (NEVER click)
5. Random reading pauses (1-3.5s, 3% chance per scroll step)
6. Optional scroll-up at end (30% chance)

---

## 🔑 IMPORTANT CONSTANTS

```
MoreLogin API: http://127.0.0.1:40000
MoreLogin API Key: 0df5ef07ccfd376ba7461deab39c040f6f80db8fc5829bfd
Smartproxy Server: us.smartproxy.net:3120
Smartproxy Password: xEdCpOSFn3nd4ixu
Smartproxy Prefix: smart-pwgbkxcy3lyi
YouTube Frontend: localhost:5178
YouTube Backend: localhost:3100
Sites Frontend: localhost:5200
Sites Backend: localhost:3200
MAX_CONCURRENT: 5 profiles at once
```

---

## 🐛 KNOWN ISSUES (Not Yet Fixed)

1. `useStore()` is not a global store — it's a hook. Works because only called in App.tsx. If called elsewhere, creates separate instance.
2. Proxy Health page shows fake/simulated data (random numbers)
3. Job Queue in YouTube tool is simulated (random success/fail after delay)
4. No database — all data in localStorage (frontend) + watch_history.json (backend)
5. No authentication on backend APIs
6. `any` types used extensively — TypeScript benefits reduced
7. No automated tests

---

## 📝 NOTES FOR DEVELOPER

- **MoreLogin MUST be running** on the computer for profiles to work. Without it, you'll see "connect ECONNREFUSED 127.0.0.1:40000"
- **localStorage is per-browser per-port** — data on localhost:5178 is different from localhost:5200
- **Channels/Sites data is in localStorage** — if you clear browser data, channels are gone
- **Backend must be started separately** — `node server/index.cjs`
- **Playwright-core is used** (not full playwright) — it connects to existing MoreLogin browser via CDP, doesn't launch its own
- **Each MoreLogin profile has its own browser fingerprint, cookies, proxy** — managed by MoreLogin app
- **Green theme = Sites tool, Red theme = YouTube tool**

---

## ⭐ Co-Founder & Made by Kuldeep Parjapati ⭐
