# Design Brief — MMB Agent 24/7 (paste this into Claude Design)

> Copy each section into Claude Design. Start with the **Design System**,
> then create one **Prototype** per page using the page specs below.

---

## APP OVERVIEW (give this first as context)

**App name:** MMB Agent 24/7 — a YouTube growth-automation control panel.
It runs many browser profiles that watch YouTube videos and perform human
-like actions (like, comment, subscribe, etc.). This is the **desktop web
dashboard** the operator uses to control everything.

**Users:** one operator managing 1–50 profiles.
**Platform:** web app (NOT mobile, NOT Electron). Desktop-first, wide screen.
**Vibe:** modern, clean, professional, and **familiar like YouTube Studio /
YouTube** so it feels easy and obvious. Calm, not flashy.

---

## DESIGN SYSTEM (create this first)

**Layout shell (every page uses this):**
- **Left sidebar** (fixed, ~240px) like YouTube — app logo on top, then nav
  items with icon + label: Dashboard, Profiles, Video Shuffle, Engagement,
  Schedule, Channels, Comments, Logs, Analytics, Monitor, Settings.
  Active item highlighted with a soft accent pill.
- **Top bar** — page title on the left; on the right: a live status cluster
  (e.g. "● 3 running", "5 queued"), a global Start/Stop, and a theme toggle.
- **Content area** — generous padding, card-based, max readable width.

**Color / theme (support BOTH dark and light):**
- Neutral base (white / very dark gray surfaces), clean.
- One accent color for primary actions (a confident red works for the
  YouTube feel, or a professional blue — show both). Use accent sparingly.
- Green = running/success, amber = pending/warning, red = stopped/error.
- Rounded corners (≈12px), soft shadows, clear hierarchy.

**Typography:** clean sans-serif (Inter / system). Big clear page titles,
readable body, generous line-height.

**Components to define in the system:**
- Buttons: primary (accent), secondary (outline), danger, ghost.
- **Toggle switch** (important — used everywhere for ON/OFF actions).
- Cards, stat tiles, tables/lists with row hover, tabs, dropdown/select,
  number/percent sliders, text inputs, modals, toast notifications,
  status badges/chips, progress bars, empty states, loading skeletons.

---

## PAGE 1 — VIDEO SHUFFLE (build first)

**Purpose:** pick videos and run watch sessions across chosen profiles.

**Layout — two columns:**
- **Left (60%) — Video list:** a header "Videos to watch" with an
  "+ Add video" input (paste YouTube URL). Below, a list of video rows;
  each row = thumbnail, title, channel, duration, a remove (x) button, and
  a drag handle to reorder. Empty state: "No videos yet — paste a link."
- **Right (40%) — Run settings panel (sticky card):**
  - Watch percentage slider (e.g. 70–95%).
  - Traffic source select (Direct / Search / Suggested).
  - Profile picker — multi-select list of profiles with checkboxes +
    "Select all". Each profile shows name + a green/grey running dot.
  - A big **Start Shuffle** primary button + a Stop button when running.
- **Bottom — Live run strip:** when running, show per-profile progress
  cards (profile name, current video title, % watched, current action).

---

## PAGE 2 — ENGAGEMENT (build second — KEY new feature)

**Purpose:** decide which YouTube actions run, GLOBALLY and **PER PROFILE**.

**Top — Global defaults card:** percentage sliders for Like %, Subscribe %,
Comment %, Dislike %, with a short helper line under each.

**Main — Per-profile action matrix (the important part):**
- A table/grid. **Each row = one profile** (name + running dot + small
  avatar). **Each column = one action** with an icon + label:
  👍 Like, 👎 Dislike, 💬 Comment, 🔔 Bell, ➕ Subscribe, ⏩ Seek,
  ⚙ Quality, ▶ Autoplay-off, 💬 CC/Captions, 📄 Description.
- **Every cell = a toggle switch** (ON/OFF) so the operator can decide,
  for each profile individually, exactly which actions run.
- Column header has a "toggle whole column" switch (turn an action ON for
  all profiles at once). Row has a "toggle whole row" switch.
- A "Save" state + a "Apply preset to all" button (presets: Safe / Normal /
  Aggressive).
- Make it scannable: ON = accent/green filled toggle, OFF = grey. The
  operator should understand the whole grid at a glance.

**Bottom:** a Start Engagement button + status.

---

## PAGE 3 — SCHEDULE (build third)

**Purpose:** run sessions now, on a timer, or on a recurring schedule.

**Layout:**
- **Top — "Run now" card:** profile picker + "Start now" button.
- **Timers section:** list of one-off timers ("run in 2h"), each with a
  countdown chip and a cancel button. An "+ Add timer" control (pick delay
  or a clock time).
- **Recurring schedules section:** cards for each saved schedule — name,
  days/time, which profiles, enabled toggle, edit + delete. "+ New
  schedule" opens a modal (name, time, repeat days, profiles, actions).
- **Right rail — upcoming queue:** a timeline list of what runs next.

---

## PAGE 4 — SETTINGS (build fourth)

**Purpose:** providers, proxy, notifications, performance, appearance.

**Layout — left settings nav + right detail panel** (tabs):
- **Browser Provider:** choose MoreLogin / Multilogin; fields for
  credentials/token; a "Test connection" button with a result badge.
- **Proxy:** default proxy settings, rotate button, status.
- **Concurrency / Performance:** a number stepper "max profiles running at
  once" with a short explanation.
- **Notifications:** enable toggle + a "Send test notification" button.
- **AI / Comments:** API key field, comment-generation toggle.
- **Appearance:** theme (dark/light/system), accent color choice.
- Each section is a clean card with clear labels, helper text, and a Save
  button that confirms with a toast.

---

## GENERAL UX RULES (tell the design tool)

- Every destructive action (delete, stop) asks for confirmation.
- Show clear running/stopped/error states with color + icon, never color
  alone.
- Loading = skeletons; empty lists = friendly empty states with a CTA.
- Keep it consistent: same card style, same toggle, same spacing everywhere.
- Desktop-first, but cards should wrap gracefully on a narrow window.
