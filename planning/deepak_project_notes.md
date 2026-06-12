# Deepak - YouTube Automation Project Notes
> Date: 2026-06-07 | Source: Handwritten notes (7 images)

---

## PROJECT OVERVIEW
**Goal:** YouTube par human jaise behaviour simulate karna using multiple browser profiles (Multilogin/Morelogin)
**Core Concept:** SHA256 based unique behaviour — har profile ka pattern alag hoga, kisi mein bhi same pattern nahi banna chahiye (chahe 5 profile ho, 10 ho, ya 20 ho)

---

## FEATURES LIST — SAB TOOL SE CONTROL HOGA (Per Profile)
> ⚠️ RULE: Har feature ka ON/OFF, timing, probability — sab tool se set hoga. Kuch bhi hardcoded nahi. Har profile ka config alag hoga.

| # | Feature | Tool Control |
|---|---------|-------------|
| 1 | Like | ON/OFF + probability % per profile |
| 2 | Dislike | ON/OFF + probability % per profile |
| 3 | Subscribe | ON/OFF + probability % per profile |
| 4 | Bell icon ON | ON/OFF per profile |
| 5 | Comment post | ON/OFF + AI-generated (har profile, har video pe alag) |
| 6 | Comment like (doosron ke comments pe) | ON/OFF + probability % per profile |
| 7 | Description expand + Links open | ON/OFF per profile |
| 8 | Play / Pause | ON/OFF + timing per profile |
| 9 | Volume up/down | ON/OFF + range per profile |
| 10 | Caption (subtitles on/off) | ON/OFF per profile |
| 11 | Ads skip duration | Duration set per profile (kitni sec baad skip) |
| 12 | Quality change | Quality value per profile (144p/240p/360p/auto etc.) |
| 13 | Seek (backward/forward) | ON/OFF + frequency per profile |
| 14 | Watch time | % range per profile (min-max) |
| 15 | Autoplay OFF | Always OFF — confirm karna hoga har baar |
| 16 | Scroll (human-like curves) | Always ON — curves + smooth + no jump |
| 17 | Sidebar clicks | Only own channel videos — verify + no repeat |

---

## DETAILED RULES PER FEATURE

### 1. Ad Skip
- **Rule 1:** Ads ke dauran jab skip button show ho tab dabana hai. Kai baar button turant show nahi hota — smart detection chahiye.
- **Rule 2:** Duration set kar sakte ho — kitni second ki ads tak dekhni hai.
- **Rule 3:** AI se smart action lena.

---

### 2. Quality Change (144p / 240p / 360p etc.)
- Tool mein jo profile assign hai (Multilogin/Morelogin) uske according quality set hogi.
- **Rule 1:** Ads chal rahi ho to quality change NAHI karni. Pehle confirm karo ki ad nahi chal rahi, phir hi quality change karo.
- Action bilkul sahi hona chahiye.
- Change ke baad confirm karo ki quality change hua ya nahi. Agar nahi hua to phir se change karo jo tool se assign quality hai wahi set ho.

---

### 3. Play / Pause
- **Rule 1:** Action random dega — 1 se 2 baar. Pause ke baad confirm karo ki video play ho gayi.
- **Rule 2:** Ye action video ki duration ka 90% watch hone ke baad hi dega.
- **Rule 3:** Ads ke dauran ye action NAHI lena. Sirf tab trigger ho jab video chal rahi ho.

---

### 4. Like / Dislike
- **Rule:** Video chal rahi ho tab hi action lena. 10% watch hone ke baad hi Like/Dislike karna.

---

### 5. Subscribe + Bell Icon ON
- Simple hai lekin confirm karo ki subscribe hua ya nahi aur bell icon on hua ya nahi.

---

### 6. Comment Post
- **Rule 1:** Scroll karke comment section tak jao, phir comment post karo.
- Comment human ki tarah dikhega — kabhi kabhi likhne mein chhoti galti bhi karna (human touch).

---

### 7. Autoplay OFF
- **Rule 1:** Autoplay HAMESHA off rehni chahiye.
- Video start hone par turant off mat karo — randomly off karna.
- Target 80% watch karna hai — ye ensure karo ki autoplay on nahi ho gayi.
- Har baar confirm karo ki autoplay off hai.

---

### 8. Volume Up/Down
- (Detailed rules noted, action video ke dauran random lena)

---

### 9. Seek (Backward / Forward)
- **Rule:** Ye action sirf video chal rahi ho tab lena, ads ke dauran NAHI.
- Only last 30 seconds mein ho.
- 1 se 3 baar hi — zyada nahi.

---

### 10. Description Expand + Links Open
- **Rule 1:** Description expand karke dekho ki koi link hai ya nahi.
- **Rule 2:** Agar links hain to open bhi karna chahiye (tab mein).

---

### 11. Scroll (Human-like)
- **Rule 1:** Scroll hamesha curves mein ho — human ki tarah. Har ek scroll unique aur smooth hona chahiye. Koi jump nahi.
- **Rule 2:** Scroll ke dauran koi aur action NAHI lena.

---

### 12. Sidebar - Related Videos (Only Own Channel)
- **Rule 1:** Jo channel tool mein add hai sirf unhi ki videos sidebar mein click karo.
- Pehle verify karo ki sidebar mein woh video hai, phir hi click karo.
- **Rule 2:** Us video ko click NAHI karna jo us profile ne us din already watch ki ho.

---

### 13. Autoplay OFF (Already covered in #7)

---

## UNIQUENESS ENGINE (SHA256 Based)
- Sha256 + clientseed + seedhash ka use karna
- Result hamesha unique aata hai
- Isi tarah har session mein unique behaviour + unique pattern banega
- AI ki taraf se smart action hoga
- **Core Principle:** Chahe 5 profile ho, 10 ho ya 20 ho — HAR profile ka pattern UNIQUE hona chahiye. Kisi mein bhi same pattern nahi banna chahiye.

---

## TOOLS
- **MoreLogin** — browser profile management (port 40000, local API)
- **Multilogin** — browser profile management (auth token + folder ID based, different API params)
- **DONO support karna hai** — backend mein dono ke liye alag API handler hoga
- Custom automation tool

---

---

## MMB AGENT 24/7 — FULL TECHNICAL DOCUMENTATION (v1.0.0)
**Co-Founder & Made by: Kuldeep Parjapati**

---

### ARCHITECTURE
- React UI (Frontend) → Vite Proxy (port 5178) → Express Backend (port 3100)
- Backend: Orchestrator (Worker Pool Manager)
- 1 Worker Thread = 1 Profile (crash isolation)
- MAX_CONCURRENT = 5 profiles at once
- Each profile: unique fingerprint, proxy IP, cookies, typing speed
- Automation Library: **nodriver (Python)** — Playwright/Puppeteer NAHI. nodriver sabse high stealth hai.
- Backend language change: Python (nodriver async based)
- CDP Connection → MoreLogin (port 40000) / Multilogin (auth token based) — DONO support
- Proxy: Smartproxy residential

---

### PROFILE MANAGEMENT (MoreLogin)
- API Base: http://127.0.0.1:40000
- Auth Header: Authorization: <raw-key> (NO "Bearer" prefix)
- POST /api/env/page → Profile list
- POST /api/env/start {envId} → debugPort
- POST /api/env/close {envId} → Stop
- POST /api/env/status {envId} → Status check
- Port changes every start — backend auto-reads from response
- Wait 10-30 sec after start for browser launch

---

### TRAFFIC SOURCE MIX (Default %)
- YouTube Search: 50%
- Channel Page: 20%
- Google Search: 15%
- Bing Search: 10%
- DuckDuckGo: 0% (optional)
- Yahoo: 0% (optional)
- Direct URL: 5%
- Per profile configurable. Primary fail → Fallback chain.

---

### SEARCH QUERY ENGINE — 5 LEVELS (Escalation)

Stop words removed first. Then:
- L1: 2-4 core keywords (most natural)
- L2: 4-6 keywords (more specific)
- L3: Channel name + 2-3 keywords
- L4: Near-full title (max 10 words, no year/special chars)
- L5: EXACT original title (last resort)

Escalation: L1 → check exact match → found? CLICK. Not found? → L2 → ... → L5 → All fail → Fallback chain.
RULE: Agar kisi bhi level pe mil gayi — wahi click. Baaki levels skip.

---

### SEARCH BAR — 4 FALLBACK METHODS
1. '/' keyboard shortcut
2. Click input#search directly
3. Click search button/icon
4. Tab key navigation (5 presses)
Each: Ctrl+A → Backspace (clear) → Human typing

### TYPING SPEED (Per Profile — Fixed for session)
- 30% profiles → SLOW: 120-280ms/char, 12% pause chance
- 40% profiles → MEDIUM: 70-180ms/char, 8% pause chance
- 30% profiles → FAST: 40-120ms/char, 4% pause chance
- ±15ms jitter per char, 5-15% random thinking pause (150-800ms)
- 15% longer pause after space (200-600ms)
- 200-800ms wait after query typed before Enter

---

### RESULTS BROWSING (Human Behavior)
- Wait 3-5 sec → Wait 1.5-3 sec → Scroll down 150-500px → Wait 1-4 sec
- Scroll down 80-400px more → Wait 0.8-3.5 sec → Scroll up 100-550px
- Wait 0.8-2.5 sec → THEN find and verify video

---

### VIDEO VERIFICATION (Before Click)
RULE: ONLY click if EXACT title + channel match.

Check top 15 results (3 scroll attempts):
- Title: exact match (case-insensitive) OR contains match
- Channel: contains match (both ways)
- BOTH must match → click

Non-YouTube sources (Google/Bing) — Scoring:
- Title 50%+ words match → +50pts | 35%+ → +35pts | 20%+ → +20pts
- Channel full match → +30pts | first word → +15pts
- Duration within 10s → +20pts | within 30s → +10pts
- Total ≥ 35pts → isMatch = true → CLICK

---

### VIDEO WATCHING — 6 PHASES

Phase timing randomized per tab:
- Phase 1 End: 5-15% of watch time
- Phase 2 End: +10-25%
- Phase 3 End: +15-30%
- Phase 4 End: +10-25%
- Phase 5 End: +10-20%
- Phase 6: Remaining

PHASE 1 (0-5/15%): NO actions. Just watching. 8-20 sec sleep.
PHASE 2 (→15-40%): Mouse move to random pos (150-900x, 100-400y). 25-55% chance. NO clicks. 10-25 sec intervals.
PHASE 3 (→30-70%): Scroll down to comments (200-700px). Pause 2-6 sec. Scroll back up.
  ★ LIKE at 40-60% progress: TOOL SE DECIDE HOGA per profile. Har profile ka like % alag set hoga tool mein. Hardcoded nahi.
PHASE 4 (→40-95%): Mouse hover in video area only (200-750x, 80-300y). NO clicks.
  ★ SUBSCRIBE at 70%+ progress: TOOL SE DECIDE HOGA per profile. Bell icon ON bhi tool se decide.
PHASE 5 (→50-100%): Scroll down 100-300px (peek related/own channel). Wait 1.5-4 sec. Scroll back.
  ★ COMMENT at 85%+ progress: TOOL SE DECIDE HOGA per profile. Comment bhi AI-generated hoga — har profile, har video pe ALAG comment. Tool mein comment page + AI integration hai.
  Mid-roll ad check: 5% chance per interval.
PHASE 6: NO actions. Natural end. 10-25 sec sleep.

Watch Time: TOOL SE DECIDE HOGA per profile. Har profile ka watch time % alag set hoga tool mein. Hardcoded nahi.

---

### UNIQUENESS ENGINE (SHA256 — From Handwritten Notes)
- SHA256 + clientseed + seedhash
- Har session mein unique behaviour + unique pattern
- Chahe 5 profile ho ya 20 — HAR profile UNIQUE pattern
- Kisi mein bhi same pattern nahi banna chahiye

---

---

## AUTOMATION LIBRARY — FINAL DECISION

### ✅ USE: nodriver (Python)
- **GitHub:** github.com/ultrafunkamsterdam/nodriver (4.3k stars)
- **Install:** `pip install nodriver`
- Successor of undetected-chromedriver
- No WebDriver, No Selenium, No ChromeDriver binary
- Direct CDP communication — minimum footprint
- Can connect to existing running browser (MoreLogin/Multilogin debugPort)
- Fully async (asyncio based)
- Cloudflare, Imperva, hCaptcha bypass karta hai
- YouTube detection se bachne ke liye BEST option

### ❌ AVOID: Playwright, Puppeteer, Selenium
- Playwright — CDP signature detectable
- Puppeteer — CDP signature detectable  
- Selenium — WebDriver flag, easily caught

### nodriver + MoreLogin/Multilogin Connection:
```python
import nodriver as uc

# MoreLogin se debugPort lo
debug_port = get_debug_port_from_morelogin(profile_id)

# nodriver existing browser se connect karo
browser = await uc.Browser.create(
    browser_args=[f'--remote-debugging-port={debug_port}']
)
# Ya direct CDP connect method use karo
```

---

## YOUTUBE DETECTION BYPASS — COMPLETE RESEARCH
> ⚠️ Ye section VIDEO WATCHING PHASES se pehle note karo — ye sab implement hona chahiye

### YouTube ke paas 15+ detection signals hain — sirf CDP se nahi bachoge

### 1. Browser Fingerprint Layer (MoreLogin/Multilogin handle karta hai)
- `navigator.webdriver` → false hona chahiye ✅ (MoreLogin patch)
- Canvas fingerprint → unique per profile ✅
- WebGL fingerprint → unique per profile ✅
- Audio context fingerprint → unique per profile ✅
- Font fingerprint → unique per profile ✅
- Screen resolution → consistent per profile ✅

### 2. Network/IP Layer
- **Proxy timezone = Browser timezone** — MUST match. Agar proxy India ka hai aur browser timezone US ka hai → instant flag.
- **Proxy language = Browser language** — Browser `Accept-Language` header proxy location se match karna chahiye.
- **WebRTC IP leak** — WebRTC se real IP leak ho sakti hai. MoreLogin handle karta hai lekin verify karna. `chrome://webrtc-internals` se check karo.
- **Proxy type** — Residential proxy best (Smartproxy). Datacenter proxies YouTube pe easily flag hoti hain.

### 3. Behavioral Signals (Automation code handle karega)
- **Mouse movement physics** — Bezier curves with acceleration + deceleration. Seedhi line = bot. Curves = human.
- **Scroll momentum** — Real scroll mein momentum hota hai — nodriver + JS injection se implement karo.
- **Click jitter** — Click coordinates mein ±2-5px random variation. Exact center click = bot.
- **Action timing distribution** — Gaussian/random distribution use karo. Fixed intervals = bot.
- **Tab focus/blur** — Real user kabhi kabhi tab switch karta hai. Occasional `document.hidden` events normal hain.
- **Keyboard idle** — Real user keyboard pe kuch nahi type karta jab video dekh raha ho (except comment).
- **Scroll during video** — Real user scroll karta hai while watching — implemented hai phases mein. ✅

### 4. Session/Cookie Layer
- **Cookie age matters** — Fresh cookies (naya Google account) suspicious hain. Purane accounts better.
- **Watch history in localStorage** — YouTube localStorage mein watch history store karta hai. Profile ke saath persist hona chahiye — MoreLogin cookies handle karta hai. ✅
- **Session persistence** — Har session mein login nahi karna chahiye — cookies se session maintain. ✅
- **Account warmup** — Naye profiles ko seedha watch-time pe mat daalo. Pehle warmup karo (news, random videos dekho).

### 5. Referrer / Traffic Source Layer
- **HTTP Referrer header** — Agar Google se aa rahe ho, referrer `https://www.google.com` hona chahiye.
- **YouTube search referrer** — `https://www.youtube.com/results?search_query=...`
- **Direct URL** — Koi referrer nahi — thoda suspicious but acceptable agar kam use ho.
- Traffic source mix already configured hai (50% YT search, 20% channel, etc.) ✅

### 6. Timing / Pattern Layer
- **No fixed schedules** — Har profile ka session time alag hona chahiye. Sab ek saath same time pe start nahi karne chahiye.
- **Session gaps** — Profiles ke beech random gap do (5-30 min). Back-to-back sessions suspicious.
- **Video length variation** — Sirf ek hi length ki videos mat dekho. Mix karo.
- **Daily session limit** — Ek profile ek din mein zyada sessions nahi karni chahiye (2-4 max).

### 7. Account Health Layer
- **Profile ka Google account active hona chahiye** — Gmail, Search, etc. bhi kabhi kabhi use karo (warmup system).
- **Channel subscribe count** — Agar profile ne 500 channels subscribe kar rakhe hain ek din mein → flag.
- **Comment frequency** — Ek profile ek din mein zyada comments nahi karni chahiye.

---

## STATUS
- Planning: Complete (handwritten notes + v1.0 doc)
- Features designed: 13 (see list above)
- Development: Not started / In progress
