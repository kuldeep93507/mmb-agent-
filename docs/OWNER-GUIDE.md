# MMB Agent 24/7 — Owner Guide
## Complete Admin & Management Documentation

**Version:** 1.5.0  
**Owner:** Kuldeep Prajapati  
**Date:** 15 May 2026

---

## TABLE OF CONTENTS

1. [Tool Overview](#tool-overview)
2. [How to Run (Development)](#how-to-run-development)
3. [License Key Management](#license-key-management)
4. [Admin Panel](#admin-panel)
5. [User Management](#user-management)
6. [Building .exe for Users](#building-exe-for-users)
7. [Settings & Configuration](#settings--configuration)
8. [GitHub Push & Updates](#github-push--updates)
9. [Passwords & Security](#passwords--security)
10. [Troubleshooting](#troubleshooting)

---

## TOOL OVERVIEW

MMB Agent 24/7 is a YouTube automation tool that:
- Uses MoreLogin anti-detect browser profiles
- Watches YouTube videos with human-like behavior
- Supports multiple traffic sources (YouTube Search, Google, Bing, Channel Page, Direct URL)
- Manages proxy rotation (Smartproxy US residential)
- Tracks analytics (views, watch time, ads, engagement)

**Tech Stack:**
- Frontend: React + TypeScript + Tailwind CSS
- Backend: Node.js + Express (port 3100)
- Browser: Playwright CDP → MoreLogin (port 40000)
- Desktop: Electron (.exe)

---

## HOW TO RUN (Development)

### Prerequisites:
- Node.js v20+ installed
- MoreLogin desktop app installed & running

### Start the tool:
```
Terminal 1: node server/index.cjs        (Backend - port 3100)
Terminal 2: npx vite --host              (Frontend - port 5178)
Browser:    http://localhost:5178
```

### Or single command:
```
npm run start
```
(Requires `concurrently` package)

### First time setup:
1. Copy `.env.example` to `.env`
2. Add your MoreLogin API key in `.env`
3. Run `npm install`
4. Start backend + frontend

---

## LICENSE KEY MANAGEMENT

### How License System Works:
- Each key format: `MMB-XXXXX-XXXX-XXXX`
- Key types: LIFETIME, YEARLY (365 days), MONTHLY (30 days)
- One key = one machine (cannot reuse on different PC)
- Keys stored in `license-keys.json`

### Generate Keys (Command Line):
```bash
node -e "const l = require('./server/license.cjs'); console.log(l.adminGenerateKeys(5, 'LIFETIME'));"
```

### Generate Keys (API):
```
POST http://localhost:3100/api/license/admin/generate
Body: { "count": 5, "type": "LIFETIME" }
```

### List All Keys:
```
GET http://localhost:3100/api/license/admin/keys
```

### Revoke a Key:
```
POST http://localhost:3100/api/license/admin/revoke
Body: { "key": "MMB-XXXXX-XXXX-XXXX" }
```

### Pre-generated Keys:
| Key | Type | Notes |
|-----|------|-------|
| MMB-OWNER-MAIN-2026 | LIFETIME | Your personal key |
| MMB-TEST-KEY1-FREE | LIFETIME | Testing |
| MMB-CTCE-Z5RV-BECX | LIFETIME | For users |
| MMB-QT7V-7RQ2-T2PF | LIFETIME | For users |
| MMB-V7RR-WSZD-MGVL | LIFETIME | For users |

---

## ADMIN PANEL

### Access:
- Sidebar → "Admin Panel"
- Password: `MMB@2026#Owner`

### Features:
- View all license keys (active/inactive)
- Generate new keys (1-50 at a time)
- Copy keys with one click
- Revoke keys (user's tool stops working)
- See which machine activated which key
- See activation date

---

## USER MANAGEMENT

### What User Needs to Install:
1. MoreLogin desktop app (morelogin.com)
2. Node.js (nodejs.org)
3. MMB Agent (you provide .exe or folder)

### What User Sees:
- Dashboard, Profiles, Channels, Scheduler, Manual Control
- Analytics, Comments, Proxy Health, Video Shuffle
- Settings (basic only — watch time, delays, quality)

### What User CANNOT See:
- Admin Panel (password protected)
- GitHub Push (hidden)
- Proxy passwords (hidden in .env)
- Source code (packed in .exe)

### Giving Access to a User:
1. Generate a license key (Admin Panel or command line)
2. Give user the .exe file (or project folder)
3. Give user the license key
4. User installs, enters key + their MoreLogin API key → done

---

## BUILDING .EXE FOR USERS

### Build Command:
```bash
npm run dist:win
```

### Output:
- `release/win-unpacked/MMB Agent 247.exe` (portable — no install needed)
- Or full installer in `release/` folder

### What to Give User:
- Zip the `release/win-unpacked/` folder
- Or upload .exe to your website/Google Drive
- Give them a license key separately

---

## SETTINGS & CONFIGURATION

### .env File (Backend):
```
MORELOGIN_API_KEY=your_key_here
MORELOGIN_PORT=40000
PROXY_SERVER=us.smartproxy.net
PROXY_PORT=3120
PROXY_PASSWORD=your_proxy_password
PROXY_PREFIX=your_proxy_prefix
BACKEND_PORT=3100
```

### Owner Password:
- File: `src/services/auth.ts`
- Default: `MMB@2026#Owner`
- Change the `OWNER_PASSWORD` variable to update

### License Secret:
- File: `server/license.cjs`
- Variable: `SECRET`
- Used for encrypting local license file

---

## GITHUB PUSH & UPDATES

### Push Update (from Settings page — Owner only):
1. Settings → "Push Update to GitHub" section
2. Enter new version number
3. Enter changelog
4. Click "Push to GitHub"

### User Gets Update:
- User opens tool → "Update Available" banner shows
- Click "Update Now" → auto git pull + npm install

### Manual Push (Terminal):
```bash
git add -A
git commit -m "v1.5.1: description"
git push
```

---

## PASSWORDS & SECURITY

| What | Password/Key | Where to Change |
|------|-------------|-----------------|
| Owner Access | MMB@2026#Owner | src/services/auth.ts |
| License Keys | MMB-XXXXX-XXXX-XXXX | license-keys.json |
| MoreLogin API | (per user) | .env file |
| Proxy Password | (your smartproxy) | .env file |

### Security Features:
- License key bound to machine (one key = one PC)
- Local license file encrypted (AES-256)
- API keys in .env (not in source code)
- Owner-only sections password protected
- Source code packed in .exe (not readable)

---

## TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| "Invalid license key" | Check key format, ensure backend is running |
| MoreLogin 401 error | Check API key in .env, ensure MoreLogin app is open |
| Profiles not loading | MoreLogin app must be running on port 40000 |
| Build fails | Run `npm install` first, check Node.js version |
| .exe won't start | Ensure Node.js is installed on target machine |
| Admin Panel not visible | Login as owner first (Settings → Owner Access) |
| Videos not playing | Check if MoreLogin profile is started |
| Analytics showing 0 | Backend must be running for tracking |

---

## FILE STRUCTURE

```
MMB-AGENT-24-7-main/
├── electron/              ← Desktop app (splash, main process)
│   ├── main.cjs
│   └── splash.html
├── server/                ← Backend
│   ├── index.cjs          (Express API server)
│   ├── agent.cjs          (Browser automation)
│   ├── worker.cjs         (Worker threads)
│   ├── orchestrator.cjs   (Worker pool manager)
│   ├── searchEngine.cjs   (Smart search + verification)
│   └── license.cjs        (License key system)
├── src/                   ← Frontend
│   ├── components/        (All UI pages)
│   ├── services/          (API clients, auth)
│   ├── store/             (State management)
│   └── App.tsx            (Main app + routing)
├── .env                   ← API keys (DO NOT SHARE)
├── license-keys.json      ← Valid keys (KEEP PRIVATE)
├── package.json           ← Dependencies + scripts
└── release/               ← Built .exe output
```

---

*© 2026 MMB Agent — Kuldeep Prajapati. All Rights Reserved.*
