# MMB Agent — AI Roadmap & Project Rules

> **These are binding project rules agreed with the owner. Do not break them.**
> Every item below was explicitly requested. Build order + status tracked here.

## 🔒 GLOBAL RULES (never violate)
1. **Never break working code.** Anything currently functioning must keep working.
   Locked YouTube actions (see ACTIONS_HANDOFF.md) stay untouched unless owner
   reports a regression.
2. **Cost/time awareness.** AI calls cost money + time. Use the cheapest model
   that works; never route everything to opus.
3. **Critical actions = AI + verification.** For things like comment submit,
   never trust AI alone — always verify the result independently.
4. **Coming-Soon features** must appear in the UI with a visible "Coming Soon"
   badge so the owner sees the feature exists but is not active yet.
5. **Level-3 / big features** require research + a written plan BEFORE building.

---

## ✅ LEVEL 1 — BUILD NOW

### 1.1 Tiered models + UI switcher  — **backend DONE, build UI**
- Backend already exists: `server_python/ai_model_config.py`
  (haiku=simple, sonnet=balanced, opus=powerful; task→tier map incl.
  `vision_ad_skip`, `selector_heal`, `popup_solve`).
- **TO BUILD:** API endpoint (`/api/ai-model`) + Settings UI so the owner can:
  - turn tiered routing ON/OFF
  - pick the model ID for each tier (haiku / sonnet / opus / default)
  - switch any time from the UI
- Must call `ai_model_config.reload_config()` after save so it takes effect.

### 1.2 Vision-first ad-skip  — **COMING SOON (UI placeholder only)**
- Do NOT build the engine yet. Add a UI toggle showing **"Coming Soon"**.
- When owner turns it ON in future, UI should still show Coming Soon until built.

### 1.3 AI comment quality (transcript/title/top-comments)  — **BUILD**
- Upgrade `generate_comment` to use real video context: transcript (if
  available), title, and top comments — produce human-like relevant comments.
- Keep title-only as fallback. Cheap model (haiku) is fine here.

### 1.4 Per-profile memory  — **BUILD**
- Each profile remembers what it did: which channels visited, what it
  commented, which videos watched → avoid repeats, look natural.
- Store per-profile; feed into comment gen + video selection.

---

## 🟡 LEVEL 2

### 2.1 Self-healing selectors  — **BUILD a SPECIAL PAGE (research first)**
- When YouTube changes its DOM (e.g. `.ytp-skip-ad-button` renamed), AI finds
  the new selector and updates it — so the owner doesn't re-inspect each time.
- **Dedicated UI page**, connected to backend, so future DOM breaks are fixed
  from the UI without touching code. Owner can also do it manually from there.
- Build with proper research. Must not break existing selector loading.

### 2.2 AI watch director  — **COMING SOON (RED line — future)**
- AI decides per session: watch length, when to pause/comment/scroll.
- Owner says current behavior is already fine; this is future-only.
- Add to UI as Coming Soon, marked in RED.

### 2.3 AI persona engine  — **COMING SOON**
- Full personality per profile driving all actions.
- Add to UI as Coming Soon.

---

## 🔴 LEVEL 3 — Future Autonomous Agent  — **NEW PAGE (placeholder + plan)**
- Create a page named **"Future Autonomous Agent"**.
- List the level-3 ideas there (goal-driven agent, campaign strategist, daily
  AI report, vision QA bot).
- **Only build after proper research + a written plan**, and never breaking
  existing working code.

---

## BUILD ORDER (current)
1. ✅ Roadmap doc (this file)
2. ▶ AI Model Switcher — API + Settings UI (Level 1.1)
3. AI comment quality (1.3)
4. Per-profile memory (1.4)
5. Coming-Soon UI placeholders (1.2 vision ad-skip, 2.2 watch director RED, 2.3 persona)
6. Self-healing selectors page (2.1) — research first
7. ✅ Future Autonomous Agent page (Level 3) — Phase 0: research + placeholder UI done
   - Plan: `planning/04_future_autonomous_agent.md`
   - Next: Phase 1 Daily AI Report (read-only API)
