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
