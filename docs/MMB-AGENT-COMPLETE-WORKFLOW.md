# MMB AGENT 24/7 — Complete Workflow & Logic Documentation
## YouTube Automation Tool — Har Feature Ka Detailed Breakdown

**Co-Founder & Made by: Kuldeep Parjapati**
**Version: 1.0.0**

---

## 📋 TABLE OF CONTENTS

1. [Architecture Overview](#1-architecture-overview)
2. [Profile Management (MoreLogin)](#2-profile-management-morelogin)
3. [Traffic Source Selection](#3-traffic-source-selection)
4. [Search Query Engine — 5 Levels](#4-search-query-engine--5-levels)
5. [Search Bar Interaction — Human-Like](#5-search-bar-interaction--human-like)
6. [Results Browsing — Human Behavior](#6-results-browsing--human-behavior)
7. [Video Verification — Before Click](#7-video-verification--before-click)
8. [Video Click Behavior](#8-video-click-behavior)
9. [Video Watching — 6 Phases](#9-video-watching--6-phases)
10. [Engagement Actions (Like/Subscribe/Comment)](#10-engagement-actions)
11. [Ad Handling](#11-ad-handling)
12. [Warmup System](#12-warmup-system)
13. [Worker Thread Architecture](#13-worker-thread-architecture)
14. [Scheduler System](#14-scheduler-system)
15. [Fallback Chain](#15-fallback-chain)
16. [Session Persistence](#16-session-persistence)
17. [Auto-Recovery System](#17-auto-recovery-system)
18. [Watch History (No Repeat)](#18-watch-history)
19. [Human-Like Typing](#19-human-like-typing)
20. [Smooth Scrolling](#20-smooth-scrolling)
21. [Dark Theme Enforcement](#21-dark-theme-enforcement)
22. [Video Quality Control](#22-video-quality-control)
23. [Autoplay Disable](#23-autoplay-disable)
24. [Analytics Tracking](#24-analytics-tracking)
25. [Profile Settings (Per-Profile Config)](#25-profile-settings)

---

## 1. ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER BROWSER (React UI)                       │
│  Dashboard | Profiles | Channels | Scheduler | Manual Control   │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Vite Proxy (port 5178)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              BACKEND (Express Server — port 3100)                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              ORCHESTRATOR (Worker Pool Manager)            │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │   │
│  │  │Worker 1 │  │Worker 2 │  │Worker 3 │  │Worker N │    │   │
│  │  │(Thread) │  │(Thread) │  │(Thread) │  │(Thread) │    │   │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘    │   │
│  └───────┼─────────────┼──────────┼─────────────┼──────────┘   │
│          ▼             ▼          ▼             ▼               │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │           PROFILE AGENT (Playwright CDP)                 │    │
│  │  Search Engine | Traffic Router | Engagement | Watch     │    │
│  └──────────────────────────┬──────────────────────────────┘    │
└─────────────────────────────┼───────────────────────────────────┘
                              │ CDP Connection
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│            MORELOGIN DESKTOP APP (port 40000)                   │
│  Anti-detect Browser | Fingerprint | Proxy (Smartproxy)         │
└─────────────────────────────────────────────────────────────────┘
```

### Key Points:
- **1 Worker Thread = 1 Profile** (crash isolation)
- **MAX_CONCURRENT = 5** profiles at once
- **Each profile** has unique: fingerprint, proxy IP, cookies, typing speed
- **Crash isolation**: Agar ek worker crash ho, baaki sab continue karte hain

---

## 2. PROFILE MANAGEMENT (MoreLogin)

### Flow:
```
MoreLogin Desktop App Start
    ↓
Settings → API & MCP → Local API Enable
    ↓
Security Verification ON → API Key Copy
    ↓
API Base: http://127.0.0.1:40000
Header: Authorization: <raw-key> (NO "Bearer" prefix!)
    ↓
POST /api/env/page → Profiles List
POST /api/env/start {envId} → {debugPort}
POST /api/env/close {envId} → Profile Stop
POST /api/env/status {envId} → Running/Stopped check
```

### Profile Start Process:
```
1. Check status → Already running? → Use existing debugPort
2. Not running → POST /api/env/start
3. Wait 10-30 sec (browser launch time)
4. Get debugPort from response
5. Playwright CDP connect: http://127.0.0.1:<debugPort>
6. Ready to automate!
```

### Important:
- Har profile ka **alag browser fingerprint** (MoreLogin manages)
- Har profile ka **alag proxy IP** (Smartproxy residential)
- Har profile ke **cookies persist** (login state maintained)
- **Port changes every start** — backend automatically reads from response

---

## 3. TRAFFIC SOURCE SELECTION

### Available Sources:
| Source | Default % | Description |
|--------|-----------|-------------|
| YouTube Search | 50% | YouTube pe search → results → click |
| Channel Page | 20% | Channel pe jaake Videos tab se click |
| Google Search | 15% | Google pe search → YouTube result click |
| Bing Search | 10% | Bing pe search → YouTube result click |
| DuckDuckGo | 0% (optional) | DDG pe search → YouTube result click |
| Yahoo | 0% (optional) | Yahoo pe search → YouTube result click |
| Direct URL | 5% | Seedha video URL open |

### Traffic Mix (Configurable per Profile):
```
Frontend Settings → Profile Config → Traffic Mix:
{
  youtubeSearch: 50,   ← 50% chance YouTube search
  channelPage: 20,     ← 20% chance channel page
  google: 15,          ← 15% chance Google
  bing: 10,            ← 10% chance Bing
  duckduckgo: 0,       ← 0% (disabled)
  yahoo: 0,            ← 0% (disabled)
  direct: 5            ← 5% chance direct URL
}
```

### Assignment Logic:
```
Har video ke liye RANDOM source pick hota hai (from mix percentages)
    ↓
Example: 50% YouTube + 20% Channel + 15% Google + 10% Bing + 5% Direct
    ↓
Random number generate → source decide
    ↓
Agar primary source FAIL → Fallback chain activate
```

---

## 4. SEARCH QUERY ENGINE — 5 LEVELS (Escalation System)

### Concept:
Real user pehle short query search karta hai, phir agar nahi milti to zyada specific query try karta hai. Same logic yahan implement hai.

### Stop Words (Hata diye jaate hain):
```
the, a, an, is, are, was, were, in, on, at, to, for, of, with, by, from,
and, or, but, not, this, that, it, its, how, what, which, who, when, where,
why, do, does, did, will, would, could, should, can, may, might, you, your,
my, our, their, his, her
```

### 5 Levels:

```
Title = "How to Make Perfect Biryani at Home 2024 | Easy Recipe"
Channel = "Chef Ranveer"

Step 1: Punctuation remove → "How to Make Perfect Biryani at Home 2024 Easy Recipe"
Step 2: Years remove → "How to Make Perfect Biryani at Home Easy Recipe"
Step 3: Stop words remove → ["Make", "Perfect", "Biryani", "Home", "Easy", "Recipe"]
```

| Level | Logic | Example Query |
|-------|-------|---------------|
| **L1** | 2-4 core keywords (sabse natural) | `make perfect biryani home` |
| **L2** | 4-6 keywords (thoda specific) | `make perfect biryani home easy recipe` |
| **L3** | Channel name + 2-3 keywords | `Chef Ranveer make perfect biryani` |
| **L4** | Near-full title (max 10 words, no year/special chars) | `Make Perfect Biryani Home Easy Recipe` |
| **L5** | EXACT original title (last resort) | `How to Make Perfect Biryani at Home 2024 | Easy Recipe` |

### Escalation Flow:
```
L1 search → Results check → EXACT title match found?
   ✅ YES → Click video → DONE (L2-L5 skip)
   ❌ NO  → L2 try karo

L2 search → Results check → EXACT title match found?
   ✅ YES → Click video → DONE (L3-L5 skip)
   ❌ NO  → L3 try karo

L3 search → Results check → EXACT title match found?
   ✅ YES → Click video → DONE
   ❌ NO  → L4 try karo

L4 search → Results check → EXACT title match found?
   ✅ YES → Click video → DONE
   ❌ NO  → L5 try karo (last chance)

L5 search → Results check → EXACT title match found?
   ✅ YES → Click video → DONE
   ❌ NO  → ALL FAILED → Fallback chain start
```

### IMPORTANT RULE:
> **Agar video kisi bhi level pe mil gayi — wahi click hoti hai. Baaki levels SKIP.**
> Levels sirf fallback hain — pehle simple, phir specific.

### Why 5 Levels?
- Real user bhi aise hi search karta hai
- YouTube coordinated detection se bachne ke liye (sab profiles same query nahi search karte)
- Agar video trending hai to L1 pe hi mil jayegi
- Agar niche video hai to L4-L5 pe milegi

---

## 5. SEARCH BAR INTERACTION — Human-Like

### 4 Fallback Methods (agar ek fail ho to next try):

```
Method 1: '/' Keyboard Shortcut (Most Reliable)
    ↓ Press '/' key
    ↓ Wait 800ms
    ↓ Check if search input focused
    ↓ Ctrl+A → Backspace (clear old text)
    ↓ Human-like typing start
    ✅ Success? → Done
    ❌ Fail? → Method 2

Method 2: Click Search Input Directly
    ↓ Find input#search element
    ↓ Click it
    ↓ Wait 500ms
    ↓ Ctrl+A → Backspace
    ↓ Human-like typing
    ✅ Success? → Done
    ❌ Fail? → Method 3

Method 3: Click Search Button/Icon
    ↓ Find #search-icon-legacy or button[aria-label="Search"]
    ↓ Click it
    ↓ Wait 800ms
    ↓ Human-like typing
    ✅ Success? → Done
    ❌ Fail? → Method 4

Method 4: Tab Key Navigation
    ↓ Press Tab 5 times
    ↓ Each time check: is search focused?
    ↓ If yes → type query
    ✅ Success? → Done
    ❌ Fail? → Search failed for this level
```

### Typing Speed (Per Profile — UNIQUE):
```
Har profile ko ek baar typing speed assign hoti hai (session ke liye fixed):

30% profiles → SLOW typer:  120-280ms per char, 12% pause chance
40% profiles → MEDIUM typer: 70-180ms per char, 8% pause chance
30% profiles → FAST typer:   40-120ms per char, 4% pause chance

Additional behaviors:
- Per-character jitter: ±15ms random variation
- 5-15% chance of random thinking pause (150-800ms)
- 15% chance of longer pause after space (200-600ms) — like thinking between words
- After full query typed: 200-800ms wait before Enter
```

---

## 6. RESULTS BROWSING — Human Behavior

### After Search Results Load:
```
Wait 3-5 sec (results render)
    ↓
Wait 1.5-3 sec more (human reading time)
    ↓
Scroll DOWN 150-500px (browse results)
    ↓
Wait 1-4 sec (reading)
    ↓
Scroll DOWN 80-400px more (maybe scroll)
    ↓
Wait 0.8-3.5 sec
    ↓
Scroll UP 100-550px (go back up)
    ↓
Wait 0.8-2.5 sec
    ↓
NOW find and verify correct video
```

### Why This Matters:
- Real user immediately click nahi karta
- Pehle results browse karta hai
- Scroll amounts RANDOM hain (har profile alag)
- 40% chance extra scroll hota hai
- YouTube ko lagta hai real user hai

---

## 7. VIDEO VERIFICATION — Before Click

### Rule: ONLY click if EXACT title + channel match. NEVER click wrong video.

### Verification Process:
```
Top 15 results check (3 scroll attempts):
    ↓
Each result ke liye:
    ├── Title extract (from a#video-title)
    ├── Channel extract (from ytd-channel-name)
    └── Compare with expected:

Title Match Check:
    ├── EXACT match (case-insensitive) → ✅ CLICK
    ├── Result contains expected title → ✅ CLICK
    ├── Expected contains result title → ✅ CLICK
    └── No match → ❌ SKIP this result

Channel Match Check (if channel name provided):
    ├── Result channel contains expected → ✅ MATCH
    ├── Expected contains result channel → ✅ MATCH
    └── No match → ❌ SKIP (even if title matches!)

BOTH must match → Click
```

### Scoring System (for non-YouTube sources like Google/Bing):
```
Title Match:
    50%+ words match  → +50 points
    35%+ words match  → +35 points
    20%+ words match  → +20 points

Channel Match:
    Full name match   → +30 points
    First word match  → +15 points

Duration Match (if available):
    Within 10 sec     → +20 points
    Within 30 sec     → +10 points

TOTAL ≥ 35 points → isMatch = true → CLICK
TOTAL < 35 points → SKIP
```

---

## 8. VIDEO CLICK BEHAVIOR

### After Finding Correct Video:
```
Mouse move to video title (natural curve, 5-12 steps)
    ↓
Wait 300-800ms (hover pause — like reading title)
    ↓
Click video
    ↓
Wait 2 sec (page load)
    ↓
Video page opens!
```

### If Video NOT Found in Results:
```
Current level failed → Try next level (L1 → L2 → L3 → L4 → L5)
    ↓
All 5 levels failed → Fallback chain:
    1. YouTube Search (if not already tried)
    2. Google Search
    3. Bing Search
    4. Direct URL (if available — last resort)
    ↓
All failed + no URL → ERROR (video not found)
```

---

## 9. VIDEO WATCHING — 6 PHASES

### Concept:
Real user video dekhte waqt alag alag cheezein karta hai — pehle focus, phir mouse move, phir comments scroll, etc. Har phase ka timing RANDOM hai (har profile/tab ke liye alag).

### Phase Timing (Randomized per tab):
```
Phase 1 End: 5-15% of watch time
Phase 2 End: Phase1 + 10-25%
Phase 3 End: Phase2 + 15-30%
Phase 4 End: Phase3 + 10-25%
Phase 5 End: Phase4 + 10-20%
Phase 6: Rest until end
```

### Phase Details:

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: Initial Focus (0% → 5-15%)                        │
│                                                             │
│ • NO actions at all                                         │
│ • Just watching (8-20 sec sleep intervals)                  │
│ • Like a real user who just started watching                │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: Occasional Mouse Move (5-15% → 15-40%)            │
│                                                             │
│ • Mouse move to random position (150-900 x, 100-400 y)     │
│ • 25-55% chance of mouse move (per interval)               │
│ • NO clicks — only movement                                │
│ • 10-25 sec between actions                                │
│ • Simulates: user moving mouse while watching              │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: Comments Scroll (15-40% → 30-70%)                 │
│                                                             │
│ • Smooth scroll DOWN to comments (200-700px)               │
│ • Pause 2-6 sec (reading comments)                         │
│ • 40% chance: extra small scroll down (50-150px)           │
│ • Scroll back UP to video player                           │
│ • Small extra scroll up (30-80px) to ensure video visible  │
│ • 30-70% chance this happens (per interval)                │
│                                                             │
│ ★ LIKE happens here (40-60% progress):                     │
│   - 70% chance of liking                                   │
│   - Mouse move → wait 500-1500ms → click like button       │
│   - Only if not already liked this video                   │
│                                                             │
│ • 15-35 sec between actions                                │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 4: Mouse Hover in Video Area (30-70% → 40-95%)       │
│                                                             │
│ • Mouse move to video player area only (200-750 x, 80-300y)│
│ • NO clicks — just hover                                   │
│ • 25-55% chance per interval                               │
│                                                             │
│ ★ SUBSCRIBE happens here (70%+ progress):                  │
│   - 30% chance of subscribing                              │
│   - Only if not already subscribed this session            │
│   - Mouse move → wait 1-3 sec → click subscribe           │
│                                                             │
│ • 12-28 sec between actions                                │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 5: Related Videos Peek (40-95% → 50-100%)            │
│                                                             │
│ • Scroll down 100-300px (peek at related/suggested)        │
│ • Wait 1.5-4 sec (looking at suggestions)                  │
│ • Scroll back up 100-300px                                 │
│ • 15-40% chance this happens                               │
│                                                             │
│ ★ COMMENT happens here (85%+ progress):                    │
│   - 20% chance of commenting                              │
│   - Scroll to comments → click comment box                 │
│   - Human-like type comment text                           │
│   - Click submit button                                    │
│   - Scroll back up                                         │
│                                                             │
│ • Mid-roll ad check (5% chance per interval)               │
│ • 15-30 sec between actions                                │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 6: End — Just Watch (remaining time)                  │
│                                                             │
│ • NO actions — natural ending                              │
│ • 10-25 sec sleep intervals                                │
│ • Video finishes naturally                                 │
└─────────────────────────────────────────────────────────────┘
```

### Watch Time Calculation:
```
Video Duration (from YouTube player) → e.g., 600 sec (10 min)
    ↓
Watch Percent: Random between watchTimeMin and watchTimeMax
    Default: 70% to 100%
    ↓
Actual Watch Time = Duration × (watchPercent / 100)
    Example: 600s × 85% = 510 sec (8.5 min)
```

### Play Verification (Every 30 seconds):
```
Every 30 sec → Check:
    ├── Is there a mid-roll ad? → Handle it (skip/wait)
    ├── Is video still playing? → Continue
    └── Is video paused? → Auto-resume (video.play())
```

---

## 10. ENGAGEMENT ACTIONS

### Like (70% chance):
```
Timing: 40-60% of video watched
Condition: likeEnabled = true AND not already liked this video
Process:
    1. Find like button (multiple selectors for different YouTube versions)
    2. Check if already liked (aria-pressed="true")
    3. If not liked → mouse move → wait 500-1500ms → click
    4. Track to analytics
```

### Subscribe (30% chance):
```
Timing: 70%+ of video watched
Condition: subscribeEnabled = true AND not already subscribed this session
Process:
    1. Find subscribe button
    2. Check text — if "Subscribed" already → skip
    3. If not subscribed → mouse move → wait 1-3 sec → click
    4. Track to analytics
```

### Comment (20% chance):
```
Timing: 85%+ of video watched (near end)
Condition: commentEnabled = true AND commentText provided AND not already commented
Process:
    1. Scroll down to comments area (400-800px)
    2. Wait 2-4 sec
    3. Click comment box (#simplebox-placeholder)
    4. Wait 1-2 sec
    5. Human-like type comment text
    6. Wait 1-2 sec
    7. Click submit button
    8. Wait 2-3 sec
    9. Scroll back up to video
    10. Track to analytics
```

### Daily Caps (from Profile Settings):
```
likeDailyCap: 5 (max 5 likes per day per profile)
subscribeDailyCap: 1 (max 1 subscribe per day)
commentDailyCap: 3 (max 3 comments per day)
```

---

## 11. AD HANDLING

### Pre-roll Ads (Before Video):
```
Video page load → Check for ad overlay
    ↓
Ad detected?
    ├── YES:
    │   ├── adSkipEnabled = true?
    │   │   ├── Wait configured time (default 15 sec + 0.5-1.5s random)
    │   │   ├── Find "Skip Ad" button
    │   │   ├── Mouse move to button area (natural)
    │   │   ├── Wait 200-500ms
    │   │   ├── Click skip
    │   │   └── Wait 1-2 sec
    │   │
    │   └── adSkipEnabled = false?
    │       ├── Watch full ad (30-60 sec wait)
    │       └── Continue
    │
    └── NO → Continue to video

Unskippable short ad:
    → Wait 10-20 sec (ad finishes automatically)

Max 5 ads handled per video (loop protection)
```

### Mid-roll Ads (During Video):
```
Every 30 sec play check → Also checks for mid-roll ad
    ↓
Mid-roll detected?
    ├── Wait configured skip time
    ├── Find skip button
    ├── Click if available AND adSkipEnabled
    └── Track to analytics
```

### Ad Tracking:
```
ads_total: Total ads encountered
ads_skipped: Ads that were skipped
ads_watched_full: Ads watched completely
ad_watch_time: Total seconds spent on ads
```

---

## 12. WARMUP SYSTEM

### Purpose:
Real user pehle YouTube homepage browse karta hai, phir search karta hai. Direct search = suspicious.

### Warmup Flow:
```
First video of session → Warmup activate (only once per session)
    ↓
Go to YouTube homepage
    ↓
Wait 2-4 sec
    ↓
Force dark theme
    ↓
Mouse move (random position)
    ↓
Wait 2-4 sec
    ↓
Scroll DOWN 200-400px
    ↓
Wait 3-6 sec (browsing homepage)
    ↓
Scroll DOWN 100-300px more
    ↓
Wait 2-5 sec
    ↓
Scroll UP 200-400px
    ↓
Wait 1-3 sec
    ↓
40% chance: Watch Shorts
    ├── Go to youtube.com/shorts
    ├── Wait 2-4 sec
    ├── Watch 1-3 shorts (5-15 sec each)
    ├── Press ArrowDown for next short
    └── Go back to homepage
    ↓
Warmup complete → Ready for actual video search
```

---

## 13. WORKER THREAD ARCHITECTURE

### Concept:
Har profile ke liye ek isolated Worker Thread spawn hota hai. Agar ek crash ho, baaki sab safe.

### Worker Lifecycle:
```
Orchestrator receives schedule
    ↓
For each profile (staggered start):
    ↓
┌─────────────────────────────────────────────┐
│ WORKER THREAD (Isolated Process)            │
│                                             │
│ 1. Wait for staggered delay (5-20s + i*3s) │
│ 2. Check MoreLogin profile status           │
│    ├── Already running? → Use debugPort     │
│    └── Not running? → Start profile         │
│ 3. Connect Playwright CDP                   │
│ 4. For each video in queue:                 │
│    ├── searchAndWatch(title, channel, cfg)  │
│    ├── Report status to main thread         │
│    ├── Wait 30-120s between videos          │
│    └── If connection lost → reconnect       │
│ 5. Disconnect Playwright                    │
│ 6. Close MoreLogin browser (free RAM)       │
│ 7. Report DONE to main thread              │
└─────────────────────────────────────────────┘
```

### Communication (Worker ↔ Main Thread):
```
Main → Worker:
    { type: 'start', profileId, videos, config, startDelay }
    { type: 'stop' }

Worker → Main:
    { type: 'status', status, currentVideo, progress }
    { type: 'log', level, message, time }
    { type: 'done', results: { watched, failed, skipped } }
    { type: 'error', error }
```

### Auto-Restart on Crash:
```
Worker crashes → Orchestrator detects
    ↓
Retries < 3?
    ├── YES → Wait 5 sec → Restart from last successful video
    └── NO → Give up, mark as failed
```

### Staggered Start:
```
Profile 1: delay = random(5-20s) + 0*3s = 5-20s
Profile 2: delay = random(5-20s) + 1*3s = 8-23s
Profile 3: delay = random(5-20s) + 2*3s = 11-26s
...
Profile N: delay = random(5-20s) + (N-1)*3s

Purpose: Sab profiles ek saath start na hon (suspicious)
```

---

## 14. SCHEDULER SYSTEM

### 5-Step Wizard (Frontend):
```
Step 1: Select Profiles (which MoreLogin profiles to use)
Step 2: Select Videos (from added channels)
Step 3: Assignment Mode:
    ├── "Same for All" → All profiles watch same videos
    └── "Per Profile" → Each profile gets different videos
Step 4: Configure Settings:
    ├── Watch time range (min-max %)
    ├── Traffic source mix
    ├── Engagement (like/subscribe/comment)
    ├── Profile delay (between profile starts)
    ├── Tab delay (between videos)
    ├── Ad skip settings
    └── Video quality
Step 5: Review & Start
```

### Timer System:
```
Manual Start: Click "Run" → Immediately starts
Scheduled Start: Set time → Backend checks every 60 sec
    ↓
Timer fires → Orchestrator.runSchedule(schedule)
    ↓
Workers spawn for each profile
    ↓
Repeat support: After all done → wait → run again
```

### Schedule Config Passed to Workers:
```javascript
{
  trafficPreference: 'custom',
  trafficMix: { youtubeSearch: 50, channelPage: 20, google: 15, bing: 10, direct: 5 },
  watchTimeMin: 70,
  watchTimeMax: 100,
  likeEnabled: true,
  likeDailyCap: 5,
  subscribeEnabled: false,
  subscribeDailyCap: 1,
  commentEnabled: true,
  commentDailyCap: 3,
  commentText: "Great video! Very helpful 🔥",
  tabDelayMin: 30,      // seconds between videos
  tabDelayMax: 120,
  adSkipEnabled: true,
  adSkipAfterSec: 15,
  videoQuality: 'auto',
  scrollDuringWatch: true
}
```

---

## 15. FALLBACK CHAIN

### When Primary Traffic Source Fails:
```
Primary Source (e.g., YouTube Search) → FAILED
    ↓
Fallback 1: YouTube Search (if not already tried)
    ↓ FAILED
Fallback 2: Google Search
    ↓ FAILED  
Fallback 3: Bing Search
    ↓ FAILED
Last Resort: Direct URL (if available)
    ↓ FAILED (or no URL)
ERROR: Video not found anywhere
```

### YouTube Search Internal Fallback (5 Levels):
```
L1 (short keywords) → FAILED
L2 (more keywords) → FAILED
L3 (channel + keywords) → FAILED
L4 (near-full title) → FAILED
L5 (exact title) → FAILED
→ YouTube Search overall = FAILED → Try next source
```

### Auto-Recovery (Agent Level):
```
searchAndWatch() fails → retryCount++
    ↓
retryCount < 3?
    ├── YES → Wait 3-8 sec → Try again (different approach)
    └── NO → Give up on this video → Move to next
```

---

## 16. SESSION PERSISTENCE

### Concept:
Real user ek hi tab mein multiple videos dekhta hai. Naya tab nahi kholta har video ke liye.

### Implementation:
```
First video → Create/get page → Save as this._lastPage
    ↓
Second video → Check: is _lastPage still alive?
    ├── YES → Reuse same page (navigate to new video)
    └── NO (crashed/closed) → Create new page → Save as _lastPage
    ↓
Third video → Same check → Reuse or create
    ↓
... continues for all videos in queue
```

### Benefits:
- Cookies/session maintained across videos
- YouTube sees continuous browsing (not separate sessions)
- Less resource usage (fewer pages open)
- More natural behavior

---

## 17. AUTO-RECOVERY SYSTEM

### 3 Levels of Recovery:

```
Level 1: Agent Retry (per video)
    ├── Max 3 retries per video
    ├── Wait 3-8 sec between retries
    └── Different approach each time

Level 2: Worker Reconnect (connection lost)
    ├── Browser connection lost (Target closed/Session closed)
    ├── Disconnect old connection
    ├── Wait 3 sec
    ├── Reconnect to same debugPort
    └── Continue with next video

Level 3: Orchestrator Restart (worker crash)
    ├── Worker thread crashes completely
    ├── Max 3 restarts
    ├── Resume from last successful video (not from beginning!)
    └── Wait 5 sec before restart
```

---

## 18. WATCH HISTORY (No Repeat)

### Purpose:
Same profile pe same video 24 hours mein dobara nahi dekhni chahiye.

### Implementation:
```
After successful watch:
    POST /api/history/add { profileId, videoTitle, watchPercent }
    ↓
Backend saves to watch_history.json:
    { profileId: "abc123", videoTitle: "...", watchedAt: timestamp, watchPercent: 85 }

Before assigning video:
    POST /api/history/check { profileId, videoTitle }
    ↓
    Response: { alreadyWatched: true/false }
    ↓
    If already watched in last 24h → SKIP this video
```

### 24-Hour Window:
```
Video watched at 10:00 AM today
    → Cannot watch again until 10:00 AM tomorrow
    → After 24h → Can watch again
```

---

## 19. HUMAN-LIKE TYPING

### Per-Profile Speed (Fixed for Session):
```
Profile created → Random speed type assigned:

SLOW (30% of profiles):
    Base delay: 120-280ms per character
    Pause chance: 12%
    
MEDIUM (40% of profiles):
    Base delay: 70-180ms per character
    Pause chance: 8%

FAST (30% of profiles):
    Base delay: 40-120ms per character
    Pause chance: 4%
```

### Per-Character Behavior:
```
For each character in text:
    1. Calculate delay = random(baseMin, baseMax) + jitter(±15ms)
    2. Minimum delay = 30ms (never faster)
    3. Type character
    4. Random pause check (pauseChance %):
       → If triggered: wait 150-800ms (thinking)
    5. Space character check (15% chance):
       → If triggered: wait 200-600ms (thinking between words)

After full text typed:
    → Wait 200-800ms before next action
```

### Example (Medium typer, "biryani recipe"):
```
'b' → 95ms
'i' → 112ms
'r' → 88ms
'y' → 145ms
'a' → 73ms
'n' → 102ms
'i' → 130ms
' ' → 89ms + 450ms (space pause triggered!)
'r' → 98ms
'e' → 115ms
'c' → 82ms + 320ms (random thinking pause!)
'i' → 107ms
'p' → 93ms
'e' → 125ms
→ Final wait: 450ms
Total: ~2.5 seconds for 14 characters
```

---

## 20. SMOOTH SCROLLING

### Concept:
Real user smooth scroll karta hai, jump nahi. Small increments with delays.

### Implementation:
```
smoothScroll(page, totalPixels=400, direction='down'):
    ↓
Steps = random(5, 12)  → e.g., 8 steps
Per step = 400 / 8 = 50px
    ↓
For each step:
    Jitter = perStep + random(-10, +10)  → e.g., 47px or 53px
    mouse.wheel(0, jitter)
    Wait random(30, 80)ms
    ↓
After all steps:
    Wait random(200, 500)ms
```

### Example (400px down, 8 steps):
```
Step 1: scroll 53px → wait 45ms
Step 2: scroll 47px → wait 62ms
Step 3: scroll 51px → wait 38ms
Step 4: scroll 49px → wait 71ms
Step 5: scroll 55px → wait 44ms
Step 6: scroll 46px → wait 58ms
Step 7: scroll 52px → wait 33ms
Step 8: scroll 48px → wait 67ms
→ Final wait: 350ms
Total: ~750ms for 400px scroll (very smooth!)
```

---

## 21. DARK THEME ENFORCEMENT

### 4 Methods (All Applied Together):
```
Method 1: Cookie
    document.cookie = 'PREF=f6=400' (YouTube dark theme cookie)

Method 2: DOM Attribute
    document.documentElement.setAttribute('dark', 'true')
    document.documentElement.style.colorScheme = 'dark'

Method 3: localStorage
    yt-player-quality → darkTheme = true

Method 4: Playwright Media Emulation
    page.emulateMedia({ colorScheme: 'dark' })
```

### When Applied:
- After every page navigation
- Before search
- After video page loads

---

## 22. VIDEO QUALITY CONTROL

### Options:
```
'auto' → Don't change (YouTube decides)
'144p' → Force 144p (save bandwidth)
'240p' → Force 240p
'360p' → Force 360p
'480p' → Force 480p
'720p' → Force 720p
'1080p' → Force 1080p
```

### Process:
```
Wait 2 sec (player loaded)
    ↓
Click settings gear icon (.ytp-settings-button)
    ↓
Wait 800ms
    ↓
Find "Quality" menu item (by position or text)
    ↓
Click it → Wait 600ms
    ↓
Find target resolution in quality options
    ↓
Click it → Wait 500ms
    ↓
If not found → Press Escape (close menu)
```

---

## 23. AUTOPLAY DISABLE

### Purpose:
Video khatam hone ke baad next video auto-play na ho.

### 4 Methods:
```
Method 1: New YouTube toggle (2025+)
    Find button[data-tooltip-target-id="autoplay-toggle-button"]
    If aria-pressed="true" → Click to disable

Method 2: Old toggle
    Find .ytp-autonav-toggle-button[aria-checked="true"]
    Click to disable

Method 3: Aria-label search
    Find button[aria-label*="Autoplay"]
    Check if ON → Click to disable

Method 4: localStorage
    Set yt-player-autoplay → { autoplay: false }
```

---

## 24. ANALYTICS TRACKING

### What Gets Tracked:
```
Per Profile:
    view: +1 (each video watched)
    watchTime: seconds watched
    session: +1 (each video session)
    like: +1 (when liked)
    subscribe: +1 (when subscribed)
    comment: +1 (when commented)
    ads_total: total ads encountered
    ads_skipped: ads skipped
    ads_watched_full: ads watched fully
    ad_watch_time: seconds on ads
    traffic_youtube-search: +1
    traffic_google: +1
    traffic_bing: +1
    traffic_direct: +1
    traffic_channel-page: +1
    traffic_duckduckgo: +1
    traffic_yahoo: +1
```

### How Tracked:
```
Agent → HTTP POST to localhost:3100/api/analytics/track
    Body: { profileId, action, value }
    ↓
Backend stores in memory (per-profile stats)
    ↓
Frontend fetches: GET /api/analytics
    ↓
Dashboard shows real-time stats
```

---

## 25. PROFILE SETTINGS (Per-Profile Config)

### Configurable Per Profile:
```
┌─────────────────────────────────────────────┐
│ TRAFFIC SETTINGS                            │
│ ├── Traffic Mix (YouTube/Google/Bing/etc %) │
│ └── Custom percentages per source           │
├─────────────────────────────────────────────┤
│ WATCH SETTINGS                              │
│ ├── Watch Time Min: 70%                     │
│ ├── Watch Time Max: 100%                    │
│ ├── Video Quality: auto/144p-1080p          │
│ └── Scroll During Watch: ON/OFF             │
├─────────────────────────────────────────────┤
│ ENGAGEMENT SETTINGS                         │
│ ├── Like: ON/OFF + Daily Cap (5)            │
│ ├── Subscribe: ON/OFF + Daily Cap (1)       │
│ └── Comment: ON/OFF + Daily Cap (3) + Text  │
├─────────────────────────────────────────────┤
│ AD SETTINGS                                 │
│ ├── Ad Skip: ON/OFF                         │
│ └── Skip After: 15 seconds                  │
├─────────────────────────────────────────────┤
│ TIMING SETTINGS                             │
│ ├── Profile Start Delay: 5-20 sec           │
│ └── Tab Delay (between videos): 30-120 sec  │
└─────────────────────────────────────────────┘
```

---

## 🔄 COMPLETE FLOW — START TO FINISH

```
USER clicks "Run Schedule" in Frontend
    ↓
Frontend → POST /api/schedule/run (schedule data)
    ↓
Backend → Orchestrator.runSchedule(schedule)
    ↓
For each profile (staggered):
    ↓
    ┌─────────────────────────────────────────────────────────┐
    │ WORKER THREAD SPAWNED                                   │
    │                                                         │
    │ 1. Wait staggered delay (5-20s + position*3s)          │
    │ 2. Start MoreLogin profile → Get debugPort              │
    │ 3. Connect Playwright CDP                               │
    │ 4. WARMUP:                                              │
    │    ├── Browse YouTube homepage (scroll around)          │
    │    └── 40% chance: Watch 1-3 Shorts                    │
    │                                                         │
    │ 5. FOR EACH VIDEO:                                      │
    │    ├── Assign traffic source (from mix %)              │
    │    ├── Execute source:                                  │
    │    │   ├── YouTube Search (5-level escalation)          │
    │    │   ├── Google Search                                │
    │    │   ├── Bing Search                                  │
    │    │   ├── Channel Page                                 │
    │    │   └── Direct URL                                   │
    │    ├── If source fails → Fallback chain                │
    │    ├── Video found → Verify (title + channel match)    │
    │    ├── Click video (human-like mouse move)             │
    │    ├── Handle pre-roll ads                              │
    │    ├── Set quality + disable autoplay                   │
    │    ├── WATCH (6 phases):                                │
    │    │   ├── Phase 1: Focus (no actions)                 │
    │    │   ├── Phase 2: Mouse moves                        │
    │    │   ├── Phase 3: Comments scroll + LIKE             │
    │    │   ├── Phase 4: Hover + SUBSCRIBE                  │
    │    │   ├── Phase 5: Related peek + COMMENT             │
    │    │   └── Phase 6: End (no actions)                   │
    │    ├── Track analytics (view, watchTime, engagement)   │
    │    ├── Track watch history (no repeat 24h)             │
    │    └── Wait 30-120s → Next video                       │
    │                                                         │
    │ 6. All videos done → Disconnect Playwright             │
    │ 7. Close MoreLogin browser (free RAM)                  │
    │ 8. Report DONE to Orchestrator                         │
    └─────────────────────────────────────────────────────────┘
    ↓
All workers done → Schedule complete!
```

---

## ⚡ QUICK REFERENCE — Key Numbers

| Parameter | Value | Purpose |
|-----------|-------|---------|
| Max Concurrent Profiles | 5 | RAM protection |
| Max Retries (per video) | 3 | Auto-recovery |
| Max Retries (worker crash) | 3 | Worker restart |
| Search Levels | 5 | Escalation queries |
| Watch Phases | 6 | Human behavior |
| Like Chance | 70% | At 40-60% progress |
| Subscribe Chance | 30% | At 70%+ progress |
| Comment Chance | 20% | At 85%+ progress |
| Warmup Shorts Chance | 40% | Before first video |
| Typing Speed (slow) | 120-280ms/char | 30% profiles |
| Typing Speed (medium) | 70-180ms/char | 40% profiles |
| Typing Speed (fast) | 40-120ms/char | 30% profiles |
| Scroll Steps | 5-12 | Smooth scroll |
| Play Check Interval | 30 sec | Auto-resume |
| Watch History Window | 24 hours | No repeat |
| Profile Start Timeout | 60 sec | MoreLogin launch |
| Tab Delay (between videos) | 30-120 sec | Human break |
| Profile Delay (stagger) | 5-20 sec + i*3s | Not all at once |
| Ad Skip After | 15 sec (configurable) | Skip ads |

---

**⭐ MMB AGENT — Co-Founder & Made by Kuldeep Parjapati ⭐**
