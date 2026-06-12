# Level 3 — Future Autonomous Agent (Research + Plan)

> **Status:** Placeholder page only. No backend wiring yet.
> **Rule:** Build only after Level 1 + Level 2 foundations are stable.
> **Never break:** Existing scheduler, agent_manager, engagement, or locked YouTube actions.

---

## Vision

Operator gives a **natural-language goal** (e.g. *"is channel ko 1000 real-feeling views"*).
The AI agent plans, assigns profiles, creates schedules, monitors results, and adjusts —
operator only sets the goal and reviews summaries.

---

## Three Level-3 Capabilities

### 1. Full Agentic Loop
```
Goal → Plan → Assign profiles → Schedule → Execute → Monitor → Adjust → repeat
```

| Step | What AI does | Existing building blocks |
|------|--------------|--------------------------|
| Goal intake | Parse NL goal into targets (channel, view count, timeframe, traffic mix) | New: `autonomous_planner` module |
| Plan | Pick videos, watch %, traffic source, engagement intensity | `orchestrator.py` (HOURLY_WEIGHTS, ViewSlot), `session_behavior.py` |
| Assign | Match profiles to slots (proxy health, memory, persona) | `agent_manager.py`, `identity_manager.py`, per-profile memory (L1.4) |
| Schedule | Create one-off + recurring runs | `SchedulerPage` + `/api/schedule/*` |
| Execute | Start workers with engagement matrix | `worker_manager.py`, `EngagementPage` settings |
| Monitor | Track views, errors, slow profiles | `analytics_store.py`, `LogsPage`, SSE logs |
| Adjust | Re-weight hours, swap profiles, pause bad runs | New: feedback loop on top of orchestrator state |

**Safety rails (mandatory before autonomy):**
- Human approval gate for first N days ("suggest → approve → run")
- Hard caps: max concurrent profiles, max daily AI spend, stop on error threshold
- Critical actions (comment submit) always verified — never AI-only (global rule)

---

### 2. AI Campaign Strategist

Answers: *which video, when, which profile, which keywords are trending?*

| Input | Source today |
|-------|--------------|
| Channel + video catalog | `ChannelsPage` / channel store |
| Historical performance | `analytics_store.py` — perProfile, dailyTrend, traffic sources |
| Profile capacity | `profiles` status, proxy expiry, running count |
| Keyword trends | `ai_brain.pick_keyword_for_persona`, `entropy.py` search escalation |
| Organic timing | `orchestrator.HOURLY_WEIGHTS` |

**Output (Phase 2 — suggest only):**
- Ranked boost list: video × time window × profile set × traffic source
- Keyword pack per video (L1–L5 escalation pre-filled)
- "Why" explanation in plain language

**Output (Phase 3 — autonomous):**
- Auto-creates schedule entries + engagement presets
- Operator can override any row before enable

---

### 3. Daily AI Report

Natural-language end-of-day summary, e.g.:
> *"Aaj 5 channels, 54 sessions. Profile-12 aur Profile-19 slow the (proxy lag).
> Kal subah 9–11 boost karo Video X, sham 7pm peak pe Video Y."*

| Data feed | API / module |
|-----------|--------------|
| Sessions, views, watch time | `/api/analytics` |
| Per-profile breakdown | `analytics_store` perProfileDaily |
| Errors / warnings | Activity logs SSE + `/api/logs` |
| Schedule completion | Scheduler state |
| Recycle cycles | `/api/recycle/*` |

**Model tier:** Haiku for daily digest (cheap). Sonnet if report includes strategy changes.
**Delivery:** In-app card + optional notification (`notification_path.py`).

---

## Prerequisites (must be DONE first)

| # | Item | Roadmap level | Why needed |
|---|------|---------------|------------|
| 1 | AI Model Switcher UI | L1.1 | Cost control for agent loops |
| 2 | Per-profile memory | L1.4 | Natural, non-repeating behavior |
| 3 | AI comment quality | L1.3 | Human-like engagement in campaigns |
| 4 | Self-healing selectors page | L2.1 | DOM breaks won't kill autonomous runs |
| 5 | Analytics stable | existing | Monitor + report feed |
| 6 | Scheduler + Engagement stable | existing | Execute layer |

---

## Implementation Phases

### Phase 0 — NOW ✅
- [x] This research doc
- [x] `FutureAutonomousAgentPage` — Coming Soon UI, plan visible to owner
- [x] Sidebar nav entry (no backend)

### Phase 1 — Daily AI Report (lowest risk)
- [ ] `POST /api/ai/daily-report` — reads analytics + logs, returns NL summary
- [ ] Page section: "Generate today's report" button
- [ ] Cache report per day in `data/ai_reports/`
- **No auto-actions** — read-only

### Phase 2 — Campaign Strategist (suggest mode)
- [ ] `POST /api/ai/campaign-plan` — input: channelId, goal, horizon
- [ ] Returns JSON plan + human-readable strategy
- [ ] UI: review table → "Apply to Scheduler" button (one-click, still manual confirm)
- [ ] Uses `orchestrator.HOURLY_WEIGHTS` for time slots

### Phase 3 — Full Agentic Loop (highest risk)
- [ ] `autonomous_agent.py` — state machine: idle → planning → running → reviewing
- [ ] Goal store in `data/autonomous_goals.json`
- [ ] Cron: every 6h re-evaluate progress vs goal
- [ ] Auto-adjust: profile swap, schedule shift, engagement tune
- [ ] **Default OFF** — enable only from this page with explicit confirmation
- [ ] Kill switch in TopBar when agent is active

### Phase 4 — Vision QA Bot (optional L3 extra)
- [ ] Screenshot sample sessions → AI verifies "looks human"
- [ ] Flag profiles with robotic patterns
- Reuses `ai_brain` vision path + `cdp_mouse` evidence

---

## Architecture Sketch

```
┌─────────────────────────────────────────────────────────┐
│  FutureAutonomousAgentPage (UI)                         │
│  Goal input · Strategy review · Daily report · Kill sw  │
└────────────────────────┬────────────────────────────────┘
                         │ REST (new, isolated routes)
┌────────────────────────▼────────────────────────────────┐
│  autonomous_agent.py  (NEW — does NOT replace existing) │
│  planner · monitor · adjuster                           │
└─┬──────────┬──────────┬──────────┬─────────────────────┘
  │          │          │          │
  ▼          ▼          ▼          ▼
orchestrator agent_mgr analytics  scheduler
  .py         .py       _store     APIs
              │                    engagement APIs
              ▼
         ai_brain.py (Haiku/Sonnet per task)
```

**Isolation principle:** New module calls existing APIs/modules. Never refactor
`agent_manager` watch loop or locked actions for L3.

---

## Cost Estimate (per active goal, per day)

| Task | Model | Calls/day | ~tokens |
|------|-------|-----------|---------|
| Daily report | Haiku | 1 | ~2k |
| Strategy refresh | Sonnet | 2–4 | ~8k |
| Monitor check | Haiku | 4–6 | ~4k |
| Full replan | Sonnet | 0–1 | ~4k |

→ ~$0.05–0.20/day per goal with tiered routing (vs $2+ if everything on Opus).

---

## Open Questions (owner decides before Phase 1)

1. **Approval mode:** Always suggest-first, or allow full auto after trust period?
2. **Goal types:** Views only, or also subs/likes/comments targets?
3. **Multi-channel:** One goal spanning many channels, or one goal = one channel?
4. **Report time:** Fixed 11pm local, or on-demand only?

---

*Last updated: 2026-06-08 — Phase 0 complete*
