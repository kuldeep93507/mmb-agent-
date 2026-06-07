# MMB-Agent-v2 vs FRESH — Verified Comparison Report

Verified line-by-line, function-by-function (not based on any README claims). Generated via direct grep/diff of actual source code.

## Background
`MMB-Agent-v2/` is a separate, independent GitHub project (`github.com/kuldeep93507/MMB-Agent-v2.git`, last commit 2026-05-30). FRESH's core engine files literally credit it in their headers: "Adapted from MMB-Agent-v2/...". So V2 is the ORIGINAL/SOURCE codebase that FRESH's engine was adapted from. Zero runtime references — not imported/used by FRESH while running.

## File-by-file function diff

### 1. orchestrator.py — BIGGEST GAP
- V2: 1442 lines / 58 defs | FRESH: 694 lines / 19 defs
- V2-only (51): JobQueue, ViewScheduler, ProfilePool, OrchestratorAudit, schedule_views, compute_concurrency_limit, mark_task_completed/failed, status_report, retry/audit logic — full job-queue + audit + scheduling system MISSING in FRESH
- FRESH-only (15): CycleState, _build_organic_slots, get_status — simpler rewrite
- VERDICT: V2's orchestrator is far more powerful/complete; FRESH is a cut-down version

### 2. guardian.py & human_engine.py — IDENTICAL
- 0 differences in function sets — same code, FRESH has the active/latest copy

### 3. entropy.py — FRESH slightly ahead
- FRESH added: _clean_search_text, _get_viewer_persona, _get_profile_seed
- V2-only: _fuzzy_channel_match
- VERDICT: FRESH better here

### 4. ai_brain.py — FRESH slightly ahead
- FRESH added: pick_keyword_for_persona
- VERDICT: FRESH slightly better

### 5. account_manager.py — BIG GAP
- V2: 2092 lines / 28 defs | FRESH: 895 lines / 14 defs
- V2-only (24): full FiveSim phone-verification system (FiveSimError, buy_number, check_order, extract_otp, poll_otp), Gmail auto-signup (GmailSignupError, GmailAccountResult), NameGenerator (generate_password, infer_gender, suggest_username) — REAL account-creation automation missing in FRESH
- FRESH-only: FakeIdentity, CreatedAccount, load_account, list_accounts (simpler)
- VERDICT: V2 vastly more feature-rich for account creation

### 6. identity_manager.py — Different approaches
- V2-only (14): GeoIPError, lookup_geoip, resolve_timezone, get_geo_profile, apply_mobile_fingerprint — GeoIP/location-based identity system
- FRESH-only (13): align_with_proxy_hint, _build_injection_js, _fetch — proxy-driven approach
- VERDICT: Neither strictly "better" — different design philosophies (V2=GeoIP-based, FRESH=proxy-based)

### 7. yt_types.py — V2 more structured
- V2-only (12): AdStrategy, EngagementIntensity, ProfileConfig, NavigationRoute, WatchSessionResult, RelatedVideoConfig
- VERDICT: V2's type system more detailed/structured

## Bottom line
FRESH was "adapted" from V2 but did NOT fully port everything. Features that exist ONLY in V2 and are missing from FRESH:
- Account-creation automation (FiveSim phone verification + Gmail auto-signup)
- Job-queue / audit / scheduling system (JobQueue, ViewScheduler, ProfilePool, OrchestratorAudit)
- GeoIP-based identity system

**Recommendation:** Do NOT delete V2 yet — it's a reference library of advanced/unported features, not junk. Keep until these features are either ported into FRESH or confirmed permanently unneeded.
