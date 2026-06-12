# PART 1 — Profile Start se Video Tak
> MMB AGENT 24/7 | Deepak Approved Flow
> Ye file sirf ek kaam karti hai: Profile on hone se lekar sahi video pe pahunchne tak ka poora plan.

---

## STEP 1 — Profile Select Karo

- Tool mein profiles list hogi (MoreLogin ya Multilogin se)
- User ne tool mein assign kiya hoga:
  - Kaunsi profile
  - Kaunsa channel
  - Kaunsi video
  - Traffic source mix
- Backend is profile ka config padhega

---

## STEP 2 — Profile Start Karo

### MoreLogin:
```
POST http://127.0.0.1:40000/api/env/start
Body: { envId: "<profile_id>" }
Response: { debugPort: 9222 }
```

### Multilogin:
```
Auth token + folder ID se profile start
Response mein debugPort milega
```

- Agar profile already running hai → existing debugPort use karo
- Nahi running → start karo, 10-30 sec wait karo (browser launch time)

---

## STEP 3 — nodriver se Browser Connect Karo

```python
import nodriver as uc

browser = await uc.connect(
    host="127.0.0.1",
    port=debug_port  # MoreLogin/Multilogin se mila hua port
)
tab = await browser.get("https://www.youtube.com")
```

- nodriver MoreLogin ke already running browser se connect karta hai
- koi webdriver flag nahi, koi automation signature nahi

---

## STEP 4 — YouTube Home Pe Jao

- `https://www.youtube.com` open karo
- 2-4 sec wait karo (page load)
- Check karo: login hai ya nahi
  - Login nahi hai → ERROR (profile ka cookie session khatam ho gaya)
  - Login hai → aage badho

---

## STEP 5 — Traffic Source Decide Karo

Tool mein har profile ke liye traffic mix set hoti hai:

| Source | Example % |
|--------|-----------|
| YouTube Search | 50% |
| Channel Page | 20% |
| Google Search | 15% |
| Bing Search | 10% |
| Direct URL | 5% |

- Random number generate karo → source decide hoga
- Is session ke liye wahi source use hoga
- Agar source fail ho → fallback chain activate

---

## STEP 6A — YouTube Search (agar source = YouTube Search)

### 6A-1: Search Bar Activate Karo (4 methods, fallback order)
1. `/` key press karo (shortcut)
2. `input#search` pe click karo
3. Search icon/button pe click karo
4. Tab key 5 baar dabao

### 6A-2: Query Type Karo (5 Level Escalation System)

**Pehle title se query banao:**
- Punctuation hatao
- Year hatao
- Stop words hatao (the, a, is, are, etc.)
- Keywords nikalo

| Level | Query Type | Example |
|-------|-----------|---------|
| L1 | 2-4 core keywords | `biryani recipe easy` |
| L2 | 4-6 keywords | `biryani recipe easy home make` |
| L3 | Channel + 2-3 keywords | `Chef Ranveer biryani recipe` |
| L4 | Near-full title | `Make Perfect Biryani Home Easy Recipe` |
| L5 | Exact original title | `How to Make Perfect Biryani at Home 2024` |

**Rule:** L1 se shuru karo → sahi video mili? → Click karo. Nahi mili → L2 try karo → ... → L5.

### 6A-3: Human Typing (per profile fixed speed)
- SLOW profile: 120-280ms per character
- MEDIUM profile: 70-180ms per character  
- FAST profile: 40-120ms per character
- Kabhi kabhi chhota pause (thinking simulation)
- Enter dabane se pehle 200-800ms wait

### 6A-4: Results Browse Karo (Human Behavior)
- 3-5 sec wait (results load)
- Scroll down thoda
- Scroll up thoda
- Phir video dhundho

---

## STEP 6B — Channel Page (agar source = Channel Page)

```
https://www.youtube.com/@ChannelName/videos
```
- Videos tab pe jao
- Target video dhundho
- Click karo

---

## STEP 6C — Google/Bing Search (agar source = Google/Bing)

- Google/Bing pe jao
- Query type karo (same 5-level system)
- Results mein YouTube link dhundho
- Scoring system se verify karo (title + channel match)
- Click karo → YouTube video open hogi

---

## STEP 6D — Direct URL (agar source = Direct)

```
browser.get("https://www.youtube.com/watch?v=VIDEO_ID")
```
- Seedha video URL open karo
- Koi search nahi

---

## STEP 7 — Video Verify Karo (Click Karne Se Pehle)

**Rule: Galat video pe kabhi click NAHI karna.**

Check karo:
- Title match — expected title aur result title compare karo
- Channel match — expected channel aur result channel compare karo
- DONO match hone chahiye → tabhi click

**Agar match nahi:**
- Next level query try karo (L1 → L2 → L3...)
- Sab fail → Fallback source try karo
- Sab fail → ERROR log karo, profile skip karo

---

## STEP 8 — Video Pe Click Karo

- Mouse naturally move karo video title ki taraf (curve mein, seedha nahi)
- 300-800ms hover karo (title padhne ka simulation)
- Click karo
- 2-3 sec wait karo (video page load)

---

## STEP 9 — Video Page Pe Confirm Karo

Video page open hone ke baad check karo:
- Sahi video hai? (title confirm)
- Video play ho rahi hai? (player state check)
- Ads chal rahi hain? (ad detection)
- Autoplay OFF hai? (check aur off karo agar on hai)
- Quality set karo (tool se assigned quality)

---

## ✅ DONE — Ab Video Watching Phase Shuru Hogi

Yahan se PART 2 ka kaam shuru hoga (6 Phases of video watching).

---

## FALLBACK CHAIN (Agar Koi Bhi Step Fail Ho)

```
Primary Source Fail
    ↓
YouTube Search try karo (agar already nahi try kiya)
    ↓
Google Search try karo
    ↓
Bing Search try karo
    ↓
Direct URL try karo (agar URL available hai)
    ↓
Sab fail → ERROR log → Is profile ka session skip
```
# PART 2 — Video Watching Engine
> MMB AGENT 24/7 | Deepak Approved
> 6 Phases concept KHATAM. Naya system: Tool + SHA256 + Engine.

---

## CORE CONCEPT

> Tool bolta hai **kya karna hai.**
> SHA256 bolta hai **kab karna hai.**
> Engine **karta hai** — human jaisa.

---

## PART A — Tool Se Kya Aata Hai (Per Profile Config)

Har profile ke liye tool mein set hota hai:

| Setting | Options |
|---------|---------|
| Like | ON / OFF |
| Dislike | ON / OFF |
| Subscribe | ON / OFF |
| Bell icon ON | ON / OFF |
| Comment post | ON / OFF |
| Comment like (doosron ke) | ON / OFF |
| Description expand | ON / OFF |
| Play / Pause | ON / OFF |
| Volume up/down | ON / OFF |
| Caption | ON / OFF |
| Seek (backward/forward) | ON / OFF |
| Quality change | 144p / 240p / 360p / 480p / auto |
| Ads skip | Duration (seconds) — kitni sec baad skip |
| Watch time range | Min% to Max% (e.g., 65% to 85%) |
| Sidebar click | ON / OFF (sirf own channel) |

**Rule:** Kuch bhi hardcoded nahi. Har profile ka config alag hoga.

---

## PART B — SHA256 Kya Generate Karta Hai

### Input:
```
profile_id + video_id + date
```

### Output:
Har **enabled** action ke liye ek exact **trigger %** (video progress point):

```
Example — Profile A, Video X, Date 2026-06-07:

Like trigger:              23.4%
Subscribe trigger:         67.8%
Bell trigger:              68.1%
Description expand:        41.2%
Play/Pause trigger:        78.5%
Volume change:              8.3%
Seek trigger:              52.7%
Comment trigger:           88.9%
Comment like trigger:      91.3%
Sidebar click trigger:     94.1%
Watch time STOP:           74.2%   ← (65-85% range ke andar)
```

### Key Rule:
- Kal same profile + same video → **naya date** → naya SHA256 → **sab % alag**
- Alag profile + same video → alag profile_id → **sab % alag**
- Koi bhi do profiles ka pattern kabhi same nahi hoga

---

## PART C — Action Trigger Boundaries (Valid Ranges)

SHA256 random generate karta hai lekin **in ranges ke andar** — kyunki real human bhi kuch actions sirf specific time pe karta hai:

| Action | Valid Trigger Range | Reason |
|--------|-------------------|--------|
| Volume | 2% - 15% | Shuruaat mein adjust hota hai |
| Like / Dislike | 10% - 85% | Thoda dekh ke like karta hai |
| Subscribe + Bell | 20% - 90% | Channel pasand aayi tab |
| Description expand | 15% - 70% | Beech mein padhta hai |
| Seek (backward/forward) | 20% - 75% | Kuch miss kiya lagta hai |
| Play / Pause | 50% - 88% | Beech mein pause karta hai |
| Comment post | 65% - 95% | Video khatam hone ke paas |
| Comment like | 70% - 95% | Comments padhke like karta hai |
| Sidebar click | 88% - 98% | Video khatam hone wali ho |
| Watch time STOP | Tool range ke andar | e.g., 65-85% → SHA256 picks exact % |

---

## PART D — Engine Kaise Kaam Karta Hai

### Step 1 — Session Start Pe Trigger List Banao
```
profile_id + video_id + date → SHA256
    ↓
Enabled actions ke liye trigger % generate karo (boundaries ke andar)
    ↓
Ek sorted timeline bani: [(8.3%, volume), (23.4%, like), (41.2%, desc), ...]
```

### Step 2 — Video Chalte Waqt Check Karo
```
Video play ho rahi hai
    ↓
Har second:
  current_progress = current_time / total_duration × 100
    ↓
Check: koi trigger point aa gaya?
  YES → wo action karo → mark as done (dobara nahi hoga)
  NO  → next second check karo
    ↓
Watch time STOP point aaya → video band karo
```

### Step 3 — Ad Detection (Sabse Pehle Check)
```
Har action se PEHLE check karo: ad chal rahi hai?
  Ad chal rahi hai → action NAHI lena (sirf ad skip logic chalega)
  Ad nahi → normal action lo
```

---

## PART E — Human Simulation Layer (Hamesha ON — Tool Se Nahi)

Ye actions nahi hain — ye **behavior** hai jis tarah se har kaam hota hai. SHA256 se bhi nahi, tool se bhi nahi — engine ka fixed part hai:

| Behavior | Detail |
|----------|--------|
| Mouse movement | Hamesha Bezier curve mein — seedha nahi |
| Click position | Exact center nahi — ±3-5px random variation |
| Scroll | Smooth momentum — no jump, no instant |
| Typing | Per profile fixed speed (slow/medium/fast) + jitter |
| Hover before click | Click se pehle 300-800ms hover |

---

## PART F — Ads Handling (Separate Logic)

Ads ka logic sab actions se alag chalta hai:

```
Ad start detect hua
    ↓
Skip button wait karo (tool se set duration)
    ↓
Skip button aaya? → click karo
Skip button nahi aaya? (non-skippable) → ad khatam hone tak wait karo
    ↓
Confirm: ad khatam hui? Video chal rahi hai?
    ↓
Normal video logic resume karo
```

**Rule:** Ads ke dauran koi bhi action nahi — like, seek, quality change, play/pause — kuch nahi.

---

## PART G — Quality Change Logic

```
Tool se assigned quality: 360p

Video start hone ke baad → quality check karo
    ↓
Already 360p hai? → kuch nahi karna
360p nahi hai? → change karo
    ↓
Confirm: quality change hua?
  YES → done
  NO  → phir se try karo
    ↓
Rule: Quality change SIRF tab karo jab ad nahi chal rahi
```

---

## PART H — Autoplay OFF (Hamesha)

```
Video page khulne ke baad → autoplay check karo
    ↓
Autoplay ON hai? → OFF karo (randomly — turant nahi)
    ↓
Video ke dauran bhi kabhi kabhi check karo
    ↓
Video khatam hone se pehle ek baar aur confirm karo: autoplay OFF hai?
```

---

## PART I — Watch Time Stop

```
SHA256 ne decide kiya: watch time stop = 74.2%

Video 74.2% pe pahunchi
    ↓
Baaki kaunse actions pending hain? (jo abhi tak nahi hue)
  Pending actions hain → unhe skip karo (ya jaldi karo agar time hai)
    ↓
Tab close karo / next profile pe jao
```

---

## SUMMARY — Poora Flow

```
Tool config load → SHA256 trigger list generate → Video start
    ↓
[Har second]: current % check → trigger aaya? → action lo (human jaisa)
    ↓
Ad aaya? → pause sab, ad handle karo, resume
    ↓
Watch time stop point → session khatam
```
# PART 3 — Video Khatam Hone Ke Baad
> MMB AGENT 24/7 | Deepak Approved

---

## Step 1 — Tab Band Karo

Watch time stop point aaya → us tab ka kaam khatam → tab band karo.

Ek profile pe multiple tabs chal rahi hain (alag alag channels ki videos).
- Ek tab khatam hui → sirf woh tab band hogi
- Doosri tabs apna kaam continue karengi
- Jab sab tabs complete → poori profile ki session complete

---

## Step 2 — Watch History Update Karo

Us tab ki video complete hote hi note karo:

```
Profile ID + Video ID + Aaj ki date = "watched"
```

**Rule:** Us din same profile se same video dobara nahi chalegi.
Scheduler assign kare ya sidebar suggest kare — pehle watch history check hogi.
