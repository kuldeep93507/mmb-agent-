# MISSING FEATURES — VERIFIED AUDIT

**Date:** 5 June 2026  
**Method:** Code-only audit. No new code written.  
**Prompt reference:** `/home/user/mmb_selectors/CURSOR_VERIFY_6_MISSING.md` — **NOT FOUND** in workspace.  
**Cross-ref:** `PROJECT_READINESS_REPORT.md` Section 8 (Promise vs Delivery).

**Status legend:**
| Symbol | Meaning |
|--------|---------|
| ❌ FULLY MISSING | No implementation; docs may claim otherwise |
| 🟡 STUB | Route/UI exists; returns fake or empty data |
| 🟠 PARTIAL | Real code exists but incomplete, unwired, or fragmented |
| 🔄 WRONG NAME | Feature exists under different API/module; UI points elsewhere |
| ✅ ACTUALLY WORKING | Code + wiring + usable without stub |

---

## 1. Ten Flask Dashboard Pages

### Status: 🟠 PARTIAL

**What actually exists:** 10 route slugs are registered and all render one Alpine.js SPA inside a single `index.html`. Home + Logs hit real dashboard APIs. Other sections are UI shells with local drafts, toasts, or placeholder text.

**What is missing:** Separate functional pages wired to production `main.py` APIs (schedule CRUD, engagement start, profile create, etc.). React/Electron UI is the real control panel; Flask dashboard is supplementary.

### Proof

Routes + page map (10 slugs):

```33:44:dashboard/app.py
    _PAGES = {
        "home": ("index.html", "Home / Dashboard"),
        "videos": ("index.html", "Video Targets"),
        "profiles": ("index.html", "Profiles"),
        "proxies": ("index.html", "Proxy Pool"),
        "engagement": ("index.html", "Engagement Engine"),
        "scheduler": ("index.html", "Scheduler"),
        "shuffle": ("index.html", "Video Shuffle"),
        "analytics": ("index.html", "Analytics"),
        "logs": ("index.html", "Logs Viewer"),
        "settings": ("index.html", "Settings"),
    }
```

Mounted on main server:

```1986:1987:server_python/main.py
    from dashboard.app import register_dashboard
    register_dashboard(app)
```

Per-section reality in template:

| Slug | Section in `index.html` | Backend wired | Functional? |
|------|-------------------------|---------------|---------------|
| home | L21-61 | `/api/stats/live`, `/api/profiles`, `/api/proxies`, `/api/logs/tail` | 🟠 Partial — 5s HTTP poll |
| videos | L64-72 | None | ❌ `addVideo()` = toast only L228 |
| profiles | L75-87 | `/api/profiles` read + fake test L116-122 | 🟠 Read-only |
| proxies | L90-94 | `/api/proxies` read | 🟠 Read-only |
| engagement | L97-106 | None — `localStorage` draft L105 | ❌ No server save |
| scheduler | L109-116 | `/api/jobs` fake queue L135-142 | 🟡 Stub job ID |
| shuffle | L119-144 | None | ❌ Static buttons; L142 says use React |
| analytics | L147-151 | None | ❌ Hardcoded Chart.js data L236-238 |
| logs | L154-162 | `/api/logs/tail` | ✅ Works |
| settings | L165-171 | None | ❌ Inputs not bound to API |

Polling (not WebSocket) on home:

```189:192:dashboard/templates/index.html
    async init() {
      await this.refresh();
      setInterval(() => this.refresh(), 5000);
      setInterval(() => this.loadLogs(), 2000);
```

Explicit “not built” markers:

```70:70:dashboard/templates/index.html
      <p class="text-xs text-slate-500">Bulk CSV import + per-video like/subscribe % — coming via API</p>
```

```114:114:dashboard/templates/index.html
      <p class="text-xs text-slate-500 mt-2">FullCalendar visual builder — next sprint</p>
```

```142:142:dashboard/templates/index.html
      <p class="text-[10px] text-slate-500">Engagement toggles: Like · Subscribe · Scroll · Quality — use React app for full config + run.</p>
```

### Honest summary

10 **URLs exist**; ~2/10 sections have real backend reads; 0/10 duplicate full React feature parity.

### Effort estimate (if building full Flask parity)

| Item | Estimate |
|------|----------|
| LOC | ~2,500–4,500 (templates + JS + API glue per page) |
| Hours | 50–90 h |
| Risk to existing code | **MEDIUM** — duplicate logic vs React; route conflicts possible |

### Existing alternatives

| Alternative | Evidence |
|-------------|----------|
| **React app (primary)** | 16 sidebar pages `App.tsx:105-188` — Engagement, Shuffle, Scheduler fully wired |
| Flask dashboard home/logs | Quick ops view at `/dashboard` — stats + JSONL tail |

### Recommendation

**SKIP building** unless you need a browser-only ops panel without Electron. React already delivers 100% of operator workflows.

---

## 2. Unified Config

### Status: 🟠 PARTIAL (fragmented — no single module)

**What actually exists:** Settings spread across `.env`, `user-settings.json`, multiple localStorage keys, and per-request dict builders. `user-settings.json` is loaded into env at startup and used by schedule/engagement endpoints.

**What is missing:** One `config` module (old `server/utils/config.cjs` was deleted with Node backend). No single read/write API for all runtime settings.

### Proof

Central file constant + startup hydration:

```61:61:server_python/main.py
SETTINGS_FILE        = ROOT / "user-settings.json"
```

```102:129:server_python/main.py
# ── Load user-settings.json into env vars at startup ─────────────────────────
    try:
        s = _load(SETTINGS_FILE, {})
        ...
        log.info("Settings loaded from user-settings.json into env vars")
```

Settings API (partial unification):

```1307:1327:server_python/main.py
@app.get("/api/settings")
...
@app.post("/api/settings")
```

**Separate config builders (not unified):**

| Source | File | Purpose |
|--------|------|---------|
| Shuffle/schedule shared | `src/utils/shuffleSettingsForSchedule.ts` | localStorage `mmb_shuffle_settings` |
| Per-profile schedule | `src/utils/profileConfigsForSchedule.ts` | Merged into schedule payload |
| Engagement job | `server_python/main.py:778-811` | Built inline in `_run_engagement_job` |
| Worker/shuffle | `server_python/worker_manager.py:44-74` | `_build_engagement_from_config()` |
| Proxy UI | `ProxySettingsPage.tsx` | localStorage + optional `/api/proxy/config` (missing) |
| Gmail tags | `src/utils/gmailProfileStore.ts` | localStorage per profile |
| Recycle engine | `recycle_engine.py:76` | Reads `user-settings.json` again |

Old unified config reference (deleted):

```
Git status: D server/utils/config.cjs — file absent from filesystem
```

### Honest summary

Config **works in production** via `.env` + `user-settings.json` + page localStorage, but there is **no unified config layer** — duplicate keys, divergent shapes (`videoQuality` vs `ytVideoQuality`), and three separate engagement dict builders.

### Effort estimate

| Item | Estimate |
|------|----------|
| LOC | ~900–1,600 (Python `config.py` + TS bridge + migration) |
| Hours | 28–45 h (includes regression testing all 4 flows) |
| Risk to existing code | **HIGH** — touches engagement, worker, recycle, settings UI |

### Existing alternatives

| Alternative | Status |
|-------------|--------|
| `GET/POST /api/settings` + `user-settings.json` | ✅ Works for server-side keys |
| `shuffleSettingsForSchedule.ts` | ✅ Works for shuffle + scheduler watch/quality |
| `.env` | ✅ Works for secrets at dev time |

### Recommendation

**Build only if** you hit settings drift bugs. For daily use, document which page owns which setting. Not blocking P-351 runs.

---

## 3. Shared Component Library

### Status: 🟠 PARTIAL (exists, low adoption)

**What actually exists:** `src/components/ui.tsx` design system (~221 lines, 15 exports). Two domain-shared components: `LiveProgressPanel`, `ShuffleRunSettingsPanel`. Shared utils (not UI components): `shuffleSettingsForSchedule.ts`, `profileConfigsForSchedule.ts`.

**What is missing:** Library-wide adoption across 16 pages; most pages use inline Tailwind. No Storybook, no package boundary, no shared form primitives for Engagement/Shuffle/Profiles.

### Proof

Design system file header + exports:

```1:7:src/components/ui.tsx
/**
 * MMB Design System — shared UI primitives
 * All components use CSS variables (light + dark aware)
 */
```

Exports: `PageShell`, `PageHeader`, `Card`, `CardHeader`, `StatBar`, `Btn`, `Badge`, `Toggle`, `Input`, `Select`, `Textarea`, `Dot`, `Empty`, `SectionLabel`, `Grid`, `SettingRow` (lines 8–220).

**Import audit — only 4 files use `./ui`:**

| File | Uses ui.tsx |
|------|-------------|
| `MonitorPage.tsx` | ✅ |
| `AnalyticsPage.tsx` | ✅ |
| `RateLimitDashboard.tsx` | ✅ |
| `RecyclePage.tsx` | ✅ (orphan — not in `App.tsx`) |

**16 routed pages in `App.tsx` → 3/16 (19%) use ui.tsx** (4th is orphan).

**Separate shared components (domain-specific):**

```8:8:src/components/SchedulerPage.tsx
import LiveProgressPanel from './LiveProgressPanel';
```

```25:25:src/components/SchedulerPage.tsx
import ShuffleRunSettingsPanel from './ShuffleRunSettingsPanel';
```

`LiveProgressPanel` imported by: Scheduler, VideoShuffle, Monitor, BacklinkPool (4 pages).  
`ShuffleRunSettingsPanel` imported by: Scheduler only (Shuffle has inline duplicate settings UI).

Pages **not** using shared library: Engagement, VideoShuffle (main UI), Profiles, Channels, Settings, Gmail Setup, etc. — inline styles / Tailwind classes.

### Honest summary

A **shared library was started** but never rolled out. Cross-page reuse today is via **utils** (`shuffleSettingsForSchedule`) and **LiveProgressPanel**, not `ui.tsx`.

### Effort estimate

| Item | Estimate |
|------|----------|
| LOC | ~2,000–3,500 (refactor 12+ pages to ui.tsx primitives) |
| Hours | 35–55 h |
| Risk to existing code | **MEDIUM** — visual regressions; no automated UI tests |

### Existing alternatives

| Alternative | Evidence |
|-------------|----------|
| `ShuffleRunSettingsPanel` | Shared schedule/shuffle settings `SchedulerPage.tsx:573` |
| `LiveProgressPanel` | Shared worker progress across 4 pages |
| Tailwind + inline styles | Current pattern on high-traffic pages |

### Recommendation

**SKIP for now** unless doing a UI consistency sprint. Does not affect automation reliability.

---

## 4. WebSocket Real-Time Feed

### Status: ❌ FULLY MISSING (HTTP polling used instead)

**What actually exists:** Zero WebSocket/SocketIO server code. All “live” UI uses `setInterval` + REST polling. Flask dashboard polls every 2–5s. CDP uses WebSocket internally (nodriver) — unrelated to app feed.

**What is missing:** `Flask-SocketIO`, `/ws/activity` endpoint, server-side emit on agent actions, frontend WebSocket client. Documented in changelog as “remaining” but not implemented.

### Proof

**No dependency:**

```1:9:server_python/requirements.txt
flask>=3.0.0
flask-cors>=4.0.0
...
# flask-socketio — NOT LISTED
```

**Grep across repo:** `flask-socketio`, `socketio`, `/ws/activity` → **0 matches** in `.py`, `.ts`, `.tsx`, `.js` source files.

**Changelog admits not built:**

```153:155:CHANGELOG_V2.md
## Remaining (Future Sprints)
- WebSocket `/ws/activity` via Flask-SocketIO
- Full 10-page dashboard (Video Targets, Scheduler calendar, Analytics charts)
```

**Polling alternatives (working today):**

| Consumer | Interval | Endpoint |
|----------|----------|----------|
| React Dashboard | 5s | `/api/workers`, `/api/health` `Dashboard.tsx:180` |
| Video Shuffle workers | 4s | `/api/workers` `VideoShufflePage.tsx:558` |
| Engagement status | 3s | `/api/engagement/status` `EngagementPage` |
| Flask dashboard home | 5s + 2s logs | `/api/stats/live`, `/api/logs/tail` `index.html:191-192` |
| Sidebar health | 30s | `/api/health`, `/api/providers/ping` `Sidebar.tsx:68` |

README mentions SSE as design choice (not implemented either):

```564:564:README.md
| State | React useState/useEffect + SSE | No Redux needed; SSE gives real-time push without WebSocket complexity |
```

SSE also **not found** in `src/` (no `EventSource` usage).

### Honest summary

“Real-time feed” = **HTTP poll everywhere**. Docs/README/CHANGELOG reference WebSocket/SSE; **code does not deliver it**.

### Effort estimate

| Item | Estimate |
|------|----------|
| LOC | ~700–1,400 (SocketIO server + emit hooks in agent_manager + React hook) |
| Hours | 22–40 h |
| Risk to existing code | **MEDIUM** — async loop + Flask threading; must not break existing poll paths |

### Existing alternatives

| Alternative | Good enough? |
|-------------|--------------|
| 3–5s HTTP polling | ✅ Yes for current scale (≤20 concurrent profiles) |
| `logs/actions.jsonl` + `/api/logs/tail` | ✅ Post-hoc action trace |
| `honestTest` audit JSON | ✅ Per-session truth table |

### Recommendation

**SKIP unless** you need sub-second UI updates or 50+ profiles. Polling is proven on P-351 runs.

---

## 5. Gmail Automation

### Status: 🔄 WRONG NAME — two different features, one stub + one unwired

This is **not one feature**. Codebase has **two separate Gmail systems**:

| System | Purpose | Status |
|--------|---------|--------|
| **A) Gmail Login Manager** | Log existing email+password into browser profiles (bulk) | 🟡 STUB API |
| **B) Gmail Account Creator** | Create NEW Gmail via 5sim OTP | 🟠 PARTIAL — backend only, no UI |

### A) Gmail Setup Page → `/api/gmail-login/*` — 🟡 STUB

UI is fully built (~660 lines). Backend returns placeholder.

```1671:1673:server_python/main.py
@app.post("/api/gmail-login/start")
def api_gmail_start():
    return jsonify({"code": 0, "message": "Gmail login not implemented yet"})
```

UI expects `data.ok` — stub never sets it → start always fails:

```224:230:src/components/GmailSetupPage.tsx
      const data = await res.json();
      if (data.ok) {
        setStartError('');
        setTab('status');
        void fetchStatus();
      } else {
        setStartError(data.error || 'Server ne start nahi kiya — error hai');
```

Status endpoint returns empty job list forever:

```1667:1669:server_python/main.py
@app.get("/api/gmail-login/status")
def api_gmail_status():
    return jsonify({"code": 0, "data": {"jobs": _gmail_jobs, "running": False}})
```

**Deleted legacy:** `server/gmailLoginManager.cjs` — git status `D`, not ported to Python.

### B) Account Manager → `/api/accounts/create` — 🟠 PARTIAL (real code, no UI)

Full implementation exists:

```1:11:server_python/account_manager.py
"""
AccountManager — Auto Gmail Creation for MMB AGENT 24/7
...
  6. Created account saved to data/accounts/{profile_id}.json
```

Wired API:

```1744:1750:server_python/main.py
@app.post("/api/accounts/create")
def api_accounts_create():
    """
    Create a Gmail account for a profile using 5sim OTP.
    Body: { "profileId": "...", "country": "usa" }
```

**No React page calls `/api/accounts/create`** — grep `src/` → 0 matches.

Requires: `FIVESIM_API_KEY`, live browser, `nodriver` — **live-tested: UNKNOWN**.

### C) Gmail profile tagging — 🟠 PARTIAL (local only)

`ProfileCard.tsx` + `gmailProfileStore.ts` — localStorage tag only; does not log into Google.

### Honest summary

- **Login existing Gmail into profiles:** UI ready, backend **missing** (stub).
- **Create new Gmail accounts:** Backend **ready**, UI **missing**.
- **Engagement like/subscribe:** Needs manual Gmail login in browser today (`verify_logged_in` on P-351 = false).

### Effort estimate

| Track | LOC | Hours | Risk |
|-------|-----|-------|------|
| A) Port Gmail Login Manager (bulk login) | ~1,800–2,800 | 45–70 h | **HIGH** — Google CAPTCHA/2FA/phone |
| B) Wire `accounts/create` to UI only | ~250–400 | 6–12 h | **MEDIUM** |
| B) Full create flow + status UI | ~800–1,200 | 20–35 h | **HIGH** — 5sim cost + failure modes |
| A+B combined | ~2,500–4,000 | 60–100 h | **HIGH** |

### Existing alternatives

| Alternative | Works today? |
|-------------|--------------|
| Manual Gmail login in MoreLogin profile | ✅ P-351 operator method |
| `gmailProfileStore` tag on ProfileCard | ✅ Metadata only |
| Skip like/subscribe when logged out | ✅ Correct agent behavior |

### Recommendation

**If engagement actions matter:** prioritize **Track A** (login manager) OR keep manual login. **Track B** only if you need new account factory, not login-to-profile.

---

## 6. Cookie Pool Import

### Status: 🟡 STUB (UI complete, backend no-op)

**What actually exists:** Full Settings UI for cookie pool (add label, paste JSON, list sets, delete). API routes exist but return empty/fake data. No storage module, no provider cookie import, no profile assignment.

**What is missing:** `CookieImporter` service (was `server/services/CookieImporter.cjs` — **deleted**). Python `profile_creator.py` has **zero** cookie references. MoreLogin/Multilogin providers have **zero** cookie import methods.

### Proof

**Status always empty:**

```1443:1452:server_python/main.py
@app.route("/api/cookies/status", methods=["GET", "POST"])
def api_cookies_status():
    return jsonify({
        "code": 0,
        "status": "ok",
        "message": "Backend running",
        "sets": [],           # Cookie sets list (empty = no cookies imported yet)
        "total": 0,
    })
```

**Import stub:**

```1648:1650:server_python/main.py
@app.post("/api/cookies/import")
def api_cookies_import():
    return jsonify({"code": 0, "message": "Not implemented"})
```

**Clear/delete stubs (no storage to clear):**

```1652:1662:server_python/main.py
@app.post("/api/cookies/clear")
def api_cookies_clear():
    return jsonify({"code": 0, "message": "Cleared"})
...
@app.route("/api/cookies/set/<set_id>", methods=["GET", "DELETE"])
def api_cookies_set(set_id: str):
    return jsonify({"code": 0})
```

**UI calls import and expects `data.count` / `data.poolSize`:**

```1031:1038:src/components/SettingsPage.tsx
                    const res = await backendFetch('/api/cookies/import', {
                      method: 'POST',
                      ...
                      body: JSON.stringify({ cookies: arr, label: cookieLabel.trim() || undefined }),
                    });
```

**HTTP method mismatch:** UI uses `DELETE` for clear; server expects `POST` `SettingsPage.tsx:957` vs `main.py:1652`.

**Deleted implementation spec only:**

```
.kiro/specs/full-profile-creation/tasks.md — CookieImporter.cjs marked done in spec
Filesystem: server/services/CookieImporter.cjs — ABSENT (git deleted)
```

**profile_creator — no cookie hook:**

```
grep "cookie" server_python/profile_creator.py → 0 matches
grep "cookie" server_python/providers/*.py → 0 matches
```

### Related but DIFFERENT feature

Settings also has **“High RPM/CPM Cookie Warmup”** toggle (`SettingsPage.tsx:864`) — visits finance sites before YouTube. **UNKNOWN** if backend honors this flag during `warm_up()` — not the same as cookie pool import.

### Honest summary

Cookie pool is **UI-only**. Import always “succeeds” with message `"Not implemented"`; pool always shows 0 sets.

### Effort estimate

| Item | Estimate |
|------|----------|
| LOC | ~900–1,500 (storage `data/cookie_pool/`, import API, MoreLogin `/api/env/cookie/import`, assign-on-create) |
| Hours | 28–45 h |
| Risk to existing code | **MEDIUM** — provider API failures; must not break profile create |

### Existing alternatives

| Alternative | Status |
|-------------|--------|
| MoreLogin manual cookie export/import | ✅ Operator can do in MoreLogin app |
| Browser session persistence | ✅ Profiles keep cookies between runs natively |
| Cookie warmup toggle | 🟠 UNKNOWN backend effect |

### Recommendation

**SKIP unless** RPM/CPM cookie strategy is core to your business. Not required for P-351 watch/engagement tests.

---

## Priority Table — Build Order vs Skip

| Priority | Feature | Verified status | Build? | Why |
|----------|---------|-----------------|--------|-----|
| — | **Flask 10 dashboard pages** | 🟠 PARTIAL shell | **SKIP** | React already has 16 full pages; duplicate effort |
| — | **WebSocket feed** | ❌ MISSING | **SKIP** | 3–5s polling works; no live-test pain reported |
| — | **Shared component library rollout** | 🟠 PARTIAL | **SKIP** | Cosmetic; 19% adoption; no automation impact |
| 3 | **Unified config** | 🟠 PARTIAL | **LATER** | Reduces drift bugs; HIGH risk; not blocking daily runs |
| 2 | **Cookie pool import** | 🟡 STUB | **LATER** | Only if RPM/CPM matters; profiles work without it |
| 1 | **Gmail automation (login manager)** | 🟡 STUB + 🔄 split | **BUILD IF NEEDED** | Blocks like/subscribe/bell at scale; manual login works for now |

### If you only fix ONE thing before scaling profiles

**Gmail Login Manager (Track A)** — wire `GmailSetupPage` to a real Python port of the old login flow, OR keep manual login and skip the page entirely.

### If you fix ZERO things

You can still run **Engagement + Shuffle + Scheduler** on profiles that are **already Gmail-signed-in** in MoreLogin (P-351 path proven for playback actions).

---

## Quick Reference Matrix

| # | Feature | Status | Exists | Missing | Alt |
|---|---------|--------|--------|---------|-----|
| 1 | 10 Flask pages | 🟠 PARTIAL | 10 routes, 1 template, 2 APIs | 8/10 sections stub | React UI |
| 2 | Unified config | 🟠 PARTIAL | `.env` + `user-settings.json` + utils | Single module | `/api/settings` |
| 3 | Shared components | 🟠 PARTIAL | `ui.tsx` + 2 panels | 81% pages not on ui.tsx | Tailwind inline |
| 4 | WebSocket feed | ❌ MISSING | Polling only | SocketIO server + client | 3–5s poll |
| 5 | Gmail automation | 🔄 WRONG NAME | `account_manager.py` + stub APIs | Login manager + UI wire | Manual login |
| 6 | Cookie pool import | 🟡 STUB | Settings UI + noop API | Storage + provider import | Native profile cookies |

---

## Audit Method

1. Read `dashboard/app.py`, `dashboard/templates/index.html` (all 10 sections)
2. Grep WebSocket/SocketIO/SSE — zero app-level implementation
3. Grep `ui.tsx` imports — 4 files
4. Read `main.py` stubs `1638-1694`, `1443-1452`, `1744-1804`
5. Read `GmailSetupPage.tsx`, `account_manager.py`, `SettingsPage.tsx` cookie section
6. Confirm `server/services/CookieImporter.cjs` absent from filesystem
7. `server_python/requirements.txt` — no flask-socketio

*No code changed. UNKNOWN items marked where live test not performed.*
