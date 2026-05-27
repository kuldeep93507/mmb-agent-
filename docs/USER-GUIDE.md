# MMB Agent 24/7 — User Guide
## Setup & Usage Instructions

**Version:** 1.5.0  
**Support:** Contact Owner for license key & help

---

## WHAT IS MMB AGENT?

MMB Agent 24/7 is a YouTube automation tool that watches videos on your behalf using multiple browser profiles. It simulates real human behavior — searching, scrolling, watching, and engaging with videos.

---

## REQUIREMENTS

Before using MMB Agent, you need:

| # | Software | Download Link | Why Needed |
|---|----------|--------------|------------|
| 1 | **MoreLogin** | https://www.morelogin.com | Anti-detect browser (creates unique profiles) |
| 2 | **Node.js** | https://nodejs.org (LTS) | Runs the backend server |
| 3 | **MMB Agent** | Provided by owner | The automation tool |
| 4 | **License Key** | Provided by owner | MMB-XXXXX-XXXX-XXXX format |

---

## INSTALLATION STEPS

### Step 1: Install MoreLogin
1. Go to https://www.morelogin.com
2. Create account & download desktop app
3. Install and login
4. Create browser profiles (minimum 1)
5. Get your API key: MoreLogin app → Settings → API → Copy key

### Step 2: Install Node.js
1. Go to https://nodejs.org
2. Download LTS version
3. Install (keep "Add to PATH" checked)
4. Restart your computer

### Step 3: Install MMB Agent
**If you received .exe file:**
- Double-click `MMB Agent 247.exe`
- Tool will open automatically

**If you received project folder:**
1. Open folder in terminal (right-click → "Open in Terminal")
2. Run: `npm install` (first time only)
3. Run: `node server/index.cjs` (keep this open)
4. Open new terminal, run: `npx vite --host`
5. Open browser: http://localhost:5178

### Step 4: First Time Setup
1. Animated splash screen will appear (wait 6 seconds)
2. **License Key page** — enter the key given by owner
3. **MoreLogin API Key page** — paste your MoreLogin API key
4. Dashboard opens — you're ready!

---

## HOW TO USE

### Dashboard
- Overview of all profiles, jobs, and system status
- Quick stats: running profiles, completed jobs, active proxies

### Profiles
- Shows all your MoreLogin profiles
- Start/Stop profiles
- View proxy info, fingerprint details
- Profile Settings: watch time, traffic preference, engagement

### Channels
- Add YouTube channels (paste channel ID)
- Auto-fetches all videos from channel
- Enable/disable specific videos
- Sync to get new videos

### Video Shuffle
- Auto-assigns unique videos to each profile
- No overlap — each profile watches different videos
- Tracks watch history (no repeats)

### Scheduler
- Create automation schedules
- Select profiles + channels + videos
- Set delays (between profiles, between videos)
- Timer options: Manual, Countdown, Scheduled
- Live progress tracking when running

### Manual Control
- Direct control of browser profiles
- Scroll, search, play/pause, skip
- Open YouTube, click videos
- All actions happen instantly

### Analytics
- Total views, watch time, sessions
- Per-profile performance
- Ad tracking (ads watched, skipped)
- Traffic source breakdown

### Settings
- MoreLogin API key (change anytime)
- Watch time percentage (70-100%)
- Video quality (auto/144p-1080p)
- Ad skip ON/OFF
- Scroll behavior ON/OFF
- Profile delays

---

## PROFILE SETTINGS (Per Profile)

Access: Profiles → click any profile → Settings

| Setting | What it does |
|---------|-------------|
| Watch Time Min/Max | How much % of video to watch (70-100%) |
| Traffic Preference | How to find video (search/direct/suggested/google/random) |
| Like | Enable/disable auto-like + daily cap |
| Subscribe | Enable/disable auto-subscribe + daily cap |
| Comment | Enable/disable auto-comment + daily cap |
| Ad Skip | Skip ads or watch full ads |
| Video Quality | Set playback quality |
| Scroll During Watch | Scroll to comments while watching |

---

## RUNNING A SCHEDULE

1. Go to **Scheduler** page
2. Click **"New Schedule"**
3. **Step 1:** Name + select profiles + select channels + set delays
4. **Step 2:** Pick videos from each channel
5. **Step 3:** Choose when to run (Manual/Countdown/Scheduled)
6. Click **"Save Schedule"**
7. Click **"Run Now"** or start countdown timer

### During Run:
- Progress bar shows completion
- Green = done, Red = failed
- Click "Stop" to cancel anytime

---

## IMPORTANT NOTES

1. **MoreLogin must be running** — always keep MoreLogin app open while using MMB Agent
2. **One license = one computer** — your key only works on your PC
3. **Don't close terminal** — if running from folder, keep terminal windows open
4. **Proxy** — proxies are pre-configured, don't change unless told by owner
5. **Updates** — when "Update Available" banner shows, click "Update Now"

---

## TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| "Invalid license key" | Check spelling, include dashes (MMB-XXXXX-XXXX-XXXX) |
| "Cannot connect to backend" | Make sure `node server/index.cjs` is running |
| Profiles not showing | Open MoreLogin app first, then refresh |
| "MoreLogin API error 401" | Check your API key in Settings |
| Video not playing | Make sure profile is started in MoreLogin |
| Tool is slow | Don't run more than 10 profiles at once |
| "No debug port" | Restart MoreLogin app and try again |

---

## SUPPORT

- Contact the owner for:
  - License key issues
  - Technical problems
  - Feature requests
  - Updates

---

*© 2026 MMB Agent 24/7 — Licensed Software. Unauthorized use prohibited.*
