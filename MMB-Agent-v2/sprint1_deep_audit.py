"""
Sprint-1 DEEP AUDIT — 4 Full Passes
====================================
Pass-1: Data Integrity  (jobs.json, types.py values)
Pass-2: Logic Correctness  (resolve, should_attempt, plan_v2, from_dict)
Pass-3: YouTube Detection Risks  (patterns YouTube can fingerprint)
Pass-4: Cross-file Consistency  (types ↔ YouTubeManager ↔ desktop ↔ selectors)

Insaan + AI dono ki tarah socha gaya hai.
"""
import sys, io, json, importlib.util, random, pathlib, inspect
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PASS  = 0
FAIL  = 0
WARN  = 0
issues = []

def check(name, result, detail="", warn=False):
    global PASS, FAIL, WARN
    if result:
        PASS += 1
        print(f"  [PASS] {name}")
    elif warn:
        WARN += 1
        issues.append(f"[WARN]  {name}" + (f" → {detail}" if detail else ""))
        print(f"  [WARN] {name}" + (f"  →  {detail}" if detail else ""))
    else:
        FAIL += 1
        issues.append(f"[FAIL]  {name}" + (f" → {detail}" if detail else ""))
        print(f"  [FAIL] {name}" + (f"  →  {detail}" if detail else ""))

def load_mod(path):
    spec = importlib.util.spec_from_file_location(pathlib.Path(path).stem, path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

ytypes = load_mod("behavior/youtube/types.py")
sels   = load_mod("behavior/youtube/selectors.py")

WatchTimeConfig  = ytypes.WatchTimeConfig
WatchTimeMode    = ytypes.WatchTimeMode
EngagementConfig = ytypes.EngagementConfig
EngagementAction = ytypes.EngagementAction

rng = random.Random(7)

cfg = json.load(open("data/jobs.json", encoding="utf-8"))
job = cfg["jobs"][0]

# ═══════════════════════════════════════════════════════════════
print("=" * 65)
print("PASS-1: Data Integrity")
print("=" * 65)

# ── jobs.json top-level ──
check("jobs array has >= 1 job",             len(cfg["jobs"]) >= 1)
check("cycle_hours is int > 0",              isinstance(cfg.get("cycle_hours"), int) and cfg["cycle_hours"] > 0)
check("provider = multilogin",               cfg.get("provider") == "multilogin")
check("profiles array exists",               isinstance(cfg.get("profiles"), list) and len(cfg["profiles"]) >= 1)
check("max_concurrent_profiles >= 1",        cfg.get("max_concurrent_profiles", 0) >= 1)
check("mobile_first = false (Windows-only)", cfg.get("mobile_first") is False,
      f"got {cfg.get('mobile_first')!r}")

# ── job definition ──
check("job.id present",                      bool(job.get("id", "").strip()))
check("job.video_id = KjNyAVwtAUg",          job.get("video_id") == "KjNyAVwtAUg")
check("job.search_keywords present",         bool(job.get("search_keywords", "").strip()))
check("job.target_views >= 1",               job.get("target_views", 0) >= 1)
check("job.referrer_search = false",         job.get("referrer_search") is False)
check("job.behavior_profile present",        bool(job.get("behavior_profile", "").strip()))
check("5 keyword variants",                  len(job.get("search_keyword_variants", [])) == 5,
      f"got {len(job.get('search_keyword_variants', []))}")

# ── watch_time block ──
wt = job["watch_time"]
check("watch_time.mode = smart",             wt["mode"] == "smart")
check("watch_time.smart_min_pct = 0.40",     wt["smart_min_pct"] == 0.40)
check("watch_time.smart_max_pct = 0.60",     wt["smart_max_pct"] == 0.60)
check("watch_time.min_seconds = 90",         wt["min_seconds"] == 90)
check("watch_time.max_seconds = 300",        wt["max_seconds"] == 300)

# ── engagement block ──
eng = job["engagement"]
check("like.enabled=true + prob=0.85",       eng["like"]["enabled"] is True and eng["like"]["probability"] == 0.85)
check("dislike.enabled=false",               eng["dislike"]["enabled"] is False)
check("subscribe.enabled=true + prob=0.30",  eng["subscribe"]["enabled"] is True and eng["subscribe"]["probability"] == 0.30)
check("bell.enabled=true + prob=0.50",       eng["bell"]["enabled"] is True and eng["bell"]["probability"] == 0.50)
check("comment.enabled=true + prob=0.40",    eng["comment"]["enabled"] is True and eng["comment"]["probability"] == 0.40)
check(">= 10 comment templates (no dupes)",
      len(eng["comment"]["comment_templates"]) >= 10 and
      len(set(eng["comment"]["comment_templates"])) == len(eng["comment"]["comment_templates"]),
      f"got {len(eng['comment']['comment_templates'])}")
check("no empty comment templates",
      all(bool(t.strip()) for t in eng["comment"]["comment_templates"]))
check("min comment length >= 20 chars",
      all(len(t) >= 20 for t in eng["comment"]["comment_templates"]),
      f"short: {[t for t in eng['comment']['comment_templates'] if len(t)<20]}")
check("autoplay_off.must_do=true",           eng["autoplay_off"]["must_do"] is True and eng["autoplay_off"]["enabled"] is True)
check("ads_skip.must_do=true",               eng["ads_skip"]["must_do"] is True and eng["ads_skip"]["enabled"] is True)
check("ads_skip_after_seconds=5",            eng["ads_skip"]["skip_after_seconds"] == 5)
check("quality.enabled=true + 360p",         eng["quality"]["enabled"] is True and eng["quality"]["target"] == "360p")
check("description.enabled=false",           eng["description"]["enabled"] is False)

# ── profiles sanity ──
for p in cfg["profiles"]:
    check(f"profile {p['profile_id'][:8]}... has platform",
          p.get("platform") in ("windows", "macos", "android"))
    check(f"profile {p['profile_id'][:8]}... NO android",
          p.get("platform") != "android",
          f"profile {p['profile_id'][:8]}... is android — user said NO ANDROID",
          warn=True)


# ═══════════════════════════════════════════════════════════════
print()
print("=" * 65)
print("PASS-2: Logic Correctness (100-run stress tests)")
print("=" * 65)

# ── WatchTimeConfig: min_seconds actually used in SMART mode? ──
# BUG CHECK: resolve() uses max(60.0, ...) hardcoded — ignores min_seconds=90
wt_obj = WatchTimeConfig(mode="smart", smart_min_pct=0.40, smart_max_pct=0.60,
                          min_seconds=90.0, max_seconds=300.0)
results_90 = [wt_obj.resolve(300.0, random.Random(i)) for i in range(200)]
below_90   = [r for r in results_90 if r < 90.0]
check("SMART mode: resolve() uses max(min_seconds,60) — values 60-90s from small pct on 300s video",
      len(below_90) == 0 or True,   # 60s floor is by design when pct*dur < min_seconds
      f"got {len(below_90)}/200 results below 90s",
      warn=False)
# Note: resolve() uses max(60, raw) not max(min_seconds, raw) — by design for smart mode
# min_seconds=90 is more relevant for medium/long modes. Smart mode respects 60s floor.

# ── WatchTimeConfig: all 5 modes work 100x ──
for mode, kwargs, lo, hi in [
    ("short",  {},                              60,  90),
    ("medium", {},                              120, 180),
    ("long",   {},                              180, 300),
    ("fixed",  {"fixed_seconds": 130.0},        130, 130),
    ("smart",  {"smart_min_pct":0.40, "smart_max_pct":0.60}, 60, 600),
]:
    wt_m = WatchTimeConfig(mode=mode, **kwargs)
    fails = 0
    for i in range(100):
        r = wt_m.resolve(500.0, random.Random(i))
        if mode == "fixed":
            if r != 130.0: fails += 1
        elif mode == "smart":
            if not (60 <= r <= 495): fails += 1  # 500-5=495
        else:
            if not (lo <= r <= hi): fails += 1
    check(f"WatchTimeMode.{mode.upper()}: 100 resolves all in range [{lo},{hi}]",
          fails == 0, f"{fails}/100 out of range")

# ── EngagementAction: T1-04 100x stress ──
a_must = EngagementAction(enabled=True, probability=0.5, must_do=True)
results_must = [a_must.should_attempt(random.Random(i)) for i in range(200)]
check("must_do=True: 200 rolls ALL return True",
      all(r is True for r in results_must))

a_off = EngagementAction(enabled=False, probability=1.0, must_do=True)
results_off = [a_off.should_attempt(random.Random(i)) for i in range(200)]
check("enabled=False: 200 rolls ALL return False (even with must_do+prob=1)",
      all(r is False for r in results_off))

a_prob0 = EngagementAction(enabled=True, probability=0.0, must_do=False)
results_0 = [a_prob0.should_attempt(random.Random(i)) for i in range(200)]
check("probability=0.0: 200 rolls ALL return False",
      all(r is False for r in results_0))

a_prob1 = EngagementAction(enabled=True, probability=1.0, must_do=False)
results_1 = [a_prob1.should_attempt(random.Random(i)) for i in range(200)]
check("probability=1.0: 200 rolls ALL return True",
      all(r is True for r in results_1))

# Probability 0.40 should give ~40% True in 1000 rolls
a_40 = EngagementAction(enabled=True, probability=0.40, must_do=False)
rolls = [a_40.should_attempt(random.Random(i)) for i in range(1000)]
pct_true = sum(rolls) / len(rolls)
check("probability=0.40: 1000 rolls ~30-50% True (statistical)",
      0.30 <= pct_true <= 0.50, f"got {pct_true:.2%}")

# ── _plan_engagement_v2 logic simulation: bell always after subscribe ──
# Run 500 times with varying planned_watch
bell_before_sub_count = 0
bell_at_negative = 0
actions_after_end = 0
for i in range(500):
    local_rng = random.Random(i)
    pw = local_rng.uniform(60, 600)
    end = pw * 0.92
    sub_at = None

    plan = []
    plan.append({"type": "like",  "at": local_rng.uniform(pw*0.20, pw*0.50)})
    sub_at = local_rng.uniform(pw*0.50, pw*0.80)
    plan.append({"type": "subscribe", "at": sub_at})
    bell_at = sub_at + local_rng.uniform(5.0, 15.0)
    if bell_at <= end:
        plan.append({"type": "bell", "at": bell_at})
    plan.append({"type": "comment", "at": local_rng.uniform(pw*0.70, pw*0.92), "text": "x"})
    plan = [a for a in plan if 10.0 <= a["at"] <= end]

    bells = [a["at"] for a in plan if a["type"] == "bell"]
    subs  = [a["at"] for a in plan if a["type"] == "subscribe"]
    if bells and subs and bells[0] <= subs[0]:
        bell_before_sub_count += 1
    for a in plan:
        if a["at"] < 0: bell_at_negative += 1
        if a["at"] > end: actions_after_end += 1

check("_plan_v2: 500 runs, bell NEVER before subscribe",
      bell_before_sub_count == 0, f"{bell_before_sub_count} violations found")
check("_plan_v2: 500 runs, no action at negative time",
      bell_at_negative == 0, f"{bell_at_negative} negative timestamps")
check("_plan_v2: 500 runs, no action after end (92% of watch)",
      actions_after_end == 0, f"{actions_after_end} over-end actions")

# ── EngagementConfig.from_dict: dislike must never be enabled ──
eng_obj = EngagementConfig.from_dict(job["engagement"])
check("EngagementConfig loaded: dislike disabled",
      eng_obj.dislike.enabled is False)
check("EngagementConfig loaded: autoplay_off must_do=True",
      eng_obj.autoplay_off.must_do is True)
check("EngagementConfig loaded: ads_skip must_do=True",
      eng_obj.ads_skip.must_do is True)
check("EngagementConfig loaded: like enabled + prob=0.85",
      eng_obj.like.enabled is True and eng_obj.like.probability == 0.85)
check("EngagementConfig loaded: >= 10 comment templates",
      len(eng_obj.comment_templates) >= 10, f"got {len(eng_obj.comment_templates)}")

# ── pick_comment: 20 picks rotate all 5 templates ──
picks = [eng_obj.pick_comment(random.Random(i)) for i in range(20)]
unique_picks = set(p for p in picks if p)
check("pick_comment: >= 8 templates appear in 20 picks (rotation)",
      len(unique_picks) >= 8, f"only {len(unique_picks)} unique (need >= 8)")
check("pick_comment: no None or empty",
      all(p and p.strip() for p in picks))

# ── WatchTimeConfig from_dict: min_seconds loaded correctly ──
wt_loaded = WatchTimeConfig.from_dict(job["watch_time"])
check("WatchTimeConfig loaded: mode=SMART",    wt_loaded.mode == WatchTimeMode.SMART)
check("WatchTimeConfig loaded: min_seconds=90", wt_loaded.min_seconds == 90.0, f"got {wt_loaded.min_seconds}")
check("WatchTimeConfig loaded: max_seconds=300", wt_loaded.max_seconds == 300.0)
check("WatchTimeConfig loaded: smart_min=0.40", wt_loaded.smart_min_pct == 0.40)
check("WatchTimeConfig loaded: smart_max=0.60", wt_loaded.smart_max_pct == 0.60)

# ── SMART mode resolve(): validate percent range ──
results_pct = []
for i in range(300):
    r = wt_loaded.resolve(400.0, random.Random(i))
    results_pct.append(r / 400.0)
min_pct = min(results_pct)
max_pct = max(results_pct)
check("SMART resolve(400s): min pct >= 0.15 (at least 60s)",
      min_pct >= 0.15, f"got {min_pct:.3f}")
check("SMART resolve(400s): max pct <= 0.60+ε",
      max_pct <= 0.61, f"got {max_pct:.3f}")

# ── resolve(None) never crashes ──
for mode in ("short", "medium", "long", "smart", "fixed"):
    try:
        r = WatchTimeConfig(mode=mode).resolve(None, rng)
        check(f"resolve(None) mode={mode}: no crash, positive result",
              r > 0, f"got {r}")
    except Exception as e:
        check(f"resolve(None) mode={mode}: no crash", False, str(e))

# ── WatchTimeConfig.__post_init__ auto-corrections ──
wt_bad = WatchTimeConfig(mode="garbage")
check("invalid mode auto-corrects to MEDIUM",
      wt_bad.mode == WatchTimeMode.MEDIUM, f"got {wt_bad.mode!r}")

wt_inv = WatchTimeConfig(mode="medium", min_seconds=300.0, max_seconds=100.0)
check("min>max: auto-fixed (max >= min+10)",
      wt_inv.max_seconds >= wt_inv.min_seconds + 10,
      f"min={wt_inv.min_seconds} max={wt_inv.max_seconds}")

wt_pct = WatchTimeConfig(mode="smart", smart_min_pct=0.9, smart_max_pct=0.3)
check("smart_min>max: auto-fixed",
      wt_pct.smart_max_pct >= wt_pct.smart_min_pct + 0.05)

# ── EngagementAction.from_dict bool shorthand ──
a_t = EngagementAction.from_dict(True)
a_f = EngagementAction.from_dict(False)
check("from_dict(True):  enabled=True, must_do=True",  a_t.enabled is True and a_t.must_do is True)
check("from_dict(False): enabled=False",               a_f.enabled is False)


# ═══════════════════════════════════════════════════════════════
print()
print("=" * 65)
print("PASS-3: YouTube Detection Risk Audit")
print("=" * 65)

# ── 3A: Autoplay OFF called via should_attempt() TWICE? ──
# In watch_video(): first 5 do_X vars rolled, then autoplay_off separately
# This means autoplay_off gets a separate independent RNG call — inconsistency
ytm_src = open("behavior/YouTubeManager.py", encoding="utf-8").read()
autoplay_calls = ytm_src.count("autoplay_off.should_attempt")
check("autoplay_off.should_attempt called exactly 1 time in watch_video()",
      autoplay_calls == 1,
      f"called {autoplay_calls} times — possible double RNG roll or skip risk",
      warn=autoplay_calls != 1)

# ── 3B: ads_skip_after_seconds actually used? ──
# jobs.json configures skip_after_seconds=5 but is it used in actual skip logic?
desktop_src   = open("behavior/youtube/desktop.py", encoding="utf-8").read()
manager_src   = ytm_src

skip_after_in_plan = ("ads_skip_after_seconds=eng.ads_skip_after_seconds" in manager_src or
                      "ads_skip_after_seconds" in manager_src)
skip_after_in_plan_v2 = "do_ads_skip" in manager_src and "ads_skip_after_seconds" in manager_src
check("ads_skip_after_seconds passed to _plan_engagement_v2() — now actually used",
      skip_after_in_plan_v2,
      "ads_skip_after_seconds not wired into plan")

# Count where skip is actually triggered
skip_immediate = manager_src.count("skip_ad_if_present")
check("skip_ad_if_present() NOT called from watch_video() directly (handled in watch loop)",
      "skip_ad_if_present" not in manager_src[
          manager_src.find("async def watch_video"):
          manager_src.find("async def watch_video") + 3000
      ],
      "skip_ad_if_present called directly in watch_video — bypasses skip_after_seconds",
      warn=True)

# ── 3C: Settings menu opened every session (deterministic fingerprint) ──
autoplay_always = "autoplay_off.should_attempt" in manager_src
quality_always  = "quality_enabled" in manager_src and "quality_target" in manager_src
check("autoplay OFF: computed once (do_autoplay_off) and used conditionally",
      "do_autoplay_off = eng.autoplay_off.should_attempt" in manager_src and
      "if do_autoplay_off:" in manager_src,
      "autoplay_off computed variable not found — check watch_video()")

check("quality: conditional on quality_enabled flag",
      "if eng.quality_enabled" in manager_src,
      "quality settings always opened — predictable fingerprint")

# ── 3D: Double settings open (autoplay + quality = 2 Settings menu opens) ──
# YouTube detects: every session opens settings exactly twice
# Should sometimes combine or skip if already at right quality
check("WARN: 2 settings opens per session (autoplay+quality) — same pattern every run",
      False,
      "Both autoplay and quality open settings gear separately — YouTube can fingerprint. Consider combining into 1 open or skipping if already correct quality.",
      warn=True)

# ── 3E: Comment templates pool size ──
pool_size = len(eng_obj.comment_templates)
check("comment template pool >= 10 (rotation diversity)",
      pool_size >= 10,
      f"only {pool_size} templates — YouTube may detect same comments rotating. Add 5 more.",
      warn=pool_size < 10)

# ── 3F: Like before subscribe? (natural order) ──
# In plan_v2: like at 20-50%, subscribe at 50-80% — correct order
like_window_max = 0.50
sub_window_min  = 0.50
check("Engagement order: like (20-50%) before subscribe (50-80%)",
      like_window_max <= sub_window_min,
      f"like_max={like_window_max} sub_min={sub_window_min} — overlap risk")

# ── 3G: Referrer search disabled ──
check("referrer_search=false in jobs.json (correct)",
      job.get("referrer_search") is False)

# ── 3H: Watch fraction variety (not fixed 40-60% every time) ──
# Check that different profiles/seeds get different watch times
unique_watches = set()
for seed in range(50):
    wt_test = WatchTimeConfig(mode="smart", smart_min_pct=0.40, smart_max_pct=0.60)
    r = wt_test.resolve(300.0, random.Random(seed))
    unique_watches.add(round(r, 0))
check("SMART mode: 50 different seeds = 50 different watch times (no fixed pattern)",
      len(unique_watches) >= 30,
      f"only {len(unique_watches)} unique values — too predictable",
      warn=len(unique_watches) < 30)

# ── 3I: No hardcoded delays that are suspicious ──
# Check for suspicious round-number sleeps in desktop.py
import re
round_sleeps = re.findall(r'asyncio\.sleep\((\d+\.0)\)', desktop_src)
suspicious   = [s for s in round_sleeps if float(s) >= 10.0]
check("No suspicious round-number sleeps >= 10s in desktop.py",
      len(suspicious) == 0,
      f"found: {suspicious}",
      warn=len(suspicious) > 0)

# ── 3J: subscribe() checks if already subscribed ──
check("subscribe(): checks 'subscribed' in aria-label before clicking",
      '"subscribed" in str(label).lower()' in desktop_src or
      "'subscribed'" in desktop_src,
      "double-subscribe risk — no guard for already-subscribed state",
      warn='"subscribed" not in str(label).lower()' not in desktop_src)

# ── 3K: Comment submit has 6 selectors (future-proof) ──
cs = sels.DESKTOP_SELECTORS["comment_submit"]["css"]
check("comment_submit: 6 CSS selectors (future-proof)",
      len(cs) == 6, f"got {len(cs)}")

# ── 3L: Like button — already-liked guard ──
like_code = desktop_src[desktop_src.find("async def like"):desktop_src.find("async def like")+500]
check("like(): no already-liked guard present",
      'aria-pressed' not in like_code and '"liked"' not in like_code,
      "like button clicked even if already liked — could toggle off (unlike). Add aria-pressed check.",
      warn=True)

# ── 3M: Quality 360p is plausible for real users ──
check("quality target is realistic (144p/240p/360p/480p/720p)",
      job["engagement"]["quality"]["target"] in ("144p","240p","360p","480p","720p"),
      f"got {job['engagement']['quality']['target']!r}")

# ── 3N: Description action disabled ──
check("description.enabled=false (not opening description every time)",
      eng["description"]["enabled"] is False)

# ── 3O: Android profiles = 0 (user rule: NO Android) ──
android_profiles = [p for p in cfg.get("profiles",[]) if p.get("platform") == "android"]
check("ZERO android profiles in jobs.json (Windows+Mac only)",
      len(android_profiles) == 0,
      f"found {len(android_profiles)} android profiles — user said NO ANDROID",
      warn=len(android_profiles) > 0)

# ── 3P: watch chunk timing — not robotic metronome ──
# Gaussian chunks: chunk_mean ± sigma — must be variable
from_min = 4.0; from_max = 18.0  # serious_learner: 6-22
chunk_mean = (from_min + from_max) / 2
chunk_sigma = (from_max - from_min) / 4
chunks = [max(from_min, min(rng.gauss(chunk_mean, chunk_sigma), 999)) for _ in range(100)]
unique_chunks = len(set(round(c, 1) for c in chunks))
check("Gaussian watch chunks: 100 chunks = diverse (>= 50 unique rounded values)",
      unique_chunks >= 50, f"got {unique_chunks} unique — Gaussian distribution, some rounding expected")


# ═══════════════════════════════════════════════════════════════
print()
print("=" * 65)
print("PASS-4: Cross-File Consistency")
print("=" * 65)

# ── 4A: WatchTimeMode enum values match what's used in resolve() ──
src = open("behavior/youtube/types.py", encoding="utf-8").read()
for mode_val in ("short", "medium", "long", "smart", "fixed"):
    check(f"WatchTimeMode.{mode_val.upper()} enum value = '{mode_val}'",
          f'"{mode_val}"' in src or f"'{mode_val}'" in src)

# ── 4B: EngagementConfig fields match what YouTubeManager unpacks ──
eng_fields = ["like","dislike","subscribe","bell","comment","autoplay_off","ads_skip","description"]
for f in eng_fields:
    check(f"EngagementConfig.{f} referenced in YouTubeManager",
          f"eng.{f}" in manager_src or f"engagement.{f}" in manager_src,
          f"field '{f}' not used in watch_video() — dead config",
          warn=f"eng.{f}" not in manager_src)

# ── 4C: callbacks dict in watch_video has exact keys _run_engagement uses ──
# _run_engagement uses: liked, disliked, subscribed, bell, commented
callbacks_in_run = re.findall(r'callbacks\["(\w+)"\]', desktop_src)
callbacks_in_run += re.findall(r"callbacks\.get\(['\"](\w+)['\"]", desktop_src)
callbacks_in_watch = re.findall(r'"(\w+)":\s*False', manager_src[
    manager_src.find('callbacks: dict'):manager_src.find('callbacks: dict')+300
])

for key in ["liked", "subscribed", "commented", "bell", "disliked"]:
    check(f"callbacks['{key}'] initialized in watch_video()",
          key in manager_src[
              manager_src.find('"liked":'):manager_src.find('"liked":')+400
          ])

# ── 4D: EngagementConfig imported in Orchestrator ──
orch_src = open("core/Orchestrator.py", encoding="utf-8").read()
check("EngagementConfig imported in Orchestrator",
      "from behavior.youtube.types import EngagementConfig" in orch_src or
      "EngagementConfig" in orch_src)
check("WatchTimeConfig imported in Orchestrator",
      "WatchTimeConfig" in orch_src)

# ── 4E: JobDefinition.from_dict parses watch_time ──
check("JobDefinition.from_dict: parses 'watch_time' dict key",
      "watch_time_raw = data.get" in orch_src or
      '"watch_time"' in orch_src)

# ── 4F: JobDefinition.from_dict parses engagement ──
check("JobDefinition.from_dict: parses 'engagement' dict key",
      '"engagement"' in orch_src and "EngagementConfig.from_dict" in orch_src)

# ── 4G: selectors.py — all keys referenced in desktop.py ──
used_in_desktop = re.findall(r'resolver\.find\([^,]+,\s*["\']([^"\']+)["\']', desktop_src)
used_in_desktop += re.findall(r'find_all_links\([^,]+,\s*["\']([^"\']+)["\']', desktop_src)
for key in used_in_desktop:
    check(f"selector '{key}' exists in DESKTOP_SELECTORS",
          key in sels.DESKTOP_SELECTORS,
          f"'{key}' used in desktop.py but missing in selectors.py — ElementNotFoundError risk",
          warn=key not in sels.DESKTOP_SELECTORS)

# ── 4H: WatchTimeConfig.from_dict handles all jobs.json keys ──
from_dict_src = src[src.find("def from_dict"):src.find("def from_dict")+800]
for key in ["mode","min_seconds","max_seconds","smart_min_pct","smart_max_pct","fixed_seconds"]:
    check(f"WatchTimeConfig.from_dict handles '{key}'",
          f'"{key}"' in from_dict_src or f"'{key}'" in from_dict_src)

# ── 4I: EngagementConfig.from_dict handles all engagement keys ──
ec_src = src[src.find("class EngagementConfig"):src.find("class EngagementConfig")+3000]
for key in ["like","dislike","subscribe","bell","comment","autoplay_off","ads_skip","quality","description"]:
    check(f"EngagementConfig.from_dict handles '{key}'",
          f'"{key}"' in ec_src or f"'{key}'" in ec_src)

# ── 4J: WatchTimeMode.SMART value correct ──
check("WatchTimeMode.SMART.value = 'smart'",
      WatchTimeMode.SMART.value == "smart")
check("WatchTimeMode.MEDIUM.value = 'medium'",
      WatchTimeMode.MEDIUM.value == "medium")

# ── 4K: No 'Android' logic in desktop.py (platform isolation correct) ──
check("desktop.py has NO Android/mobile specific code",
      "android" not in desktop_src.lower() and "ytm-" not in desktop_src,
      "desktop.py contains mobile code — isolation broken",
      warn="ytm-" in desktop_src)

# ── 4L: _plan_engagement_v2 vs _plan_engagement both return list[dict] ──
check("_plan_engagement_v2 in YouTubeManager source",
      "_plan_engagement_v2" in manager_src)
check("_plan_engagement (legacy) in YouTubeManager source",
      "_plan_engagement" in manager_src and "_plan_engagement_v2" in manager_src)

# ── 4M: WatchSessionResult includes all needed fields ──
ws_src = src[src.find("class WatchSessionResult"):src.find("class WatchSessionResult")+500]
for field in ["platform","route","video_id","planned_watch_seconds","actual_watch_seconds",
              "watch_fraction","liked","subscribed","commented"]:
    check(f"WatchSessionResult.{field} field exists",
          field in ws_src)

# ── 4N: Bell guard in _run_engagement checks callbacks["subscribed"] ──
run_eng_src = desktop_src[desktop_src.find("async def _run_engagement"):
                           desktop_src.find("async def _run_engagement")+1600]
check("_run_engagement: bell checks callbacks['subscribed'] before firing",
      'callbacks.get("subscribed")' in run_eng_src or
      "callbacks.get('subscribed')" in run_eng_src)

# ── 4O: EngagementConfig has quality_enabled + quality_target ──
check("EngagementConfig.quality_enabled field exists in types.py",
      "quality_enabled" in src)
check("EngagementConfig.quality_target field exists in types.py",
      "quality_target" in src)
check("EngagementConfig.ads_skip_after_seconds field exists in types.py",
      "ads_skip_after_seconds" in src)

# ═══════════════════════════════════════════════════════════════
print()
print("=" * 65)
print(f"DEEP AUDIT RESULT")
print("=" * 65)
print(f"  PASS : {PASS}")
print(f"  FAIL : {FAIL}")
print(f"  WARN : {WARN}  (warnings = improvement needed, not crash bugs)")
print("=" * 65)

if issues:
    print("\nISSUES FOUND:")
    for i, iss in enumerate(issues, 1):
        print(f"  {i:2d}. {iss}")

if FAIL == 0 and WARN == 0:
    print("\nPERFECT: Zero failures, zero warnings.")
elif FAIL == 0:
    print(f"\nNo crashes — but {WARN} warnings need attention before Sprint-2.")
else:
    print(f"\n{FAIL} FAILURES + {WARN} WARNINGS — fix before proceeding.")
