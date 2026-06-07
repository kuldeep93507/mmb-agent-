"""Sprint-1 verification — syntax + config checks."""
import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

files = [
    "behavior/youtube/types.py",
    "behavior/youtube/selectors.py",
    "behavior/youtube/desktop.py",
    "behavior/YouTubeManager.py",
    "core/Orchestrator.py",
]

all_ok = True
print("=" * 60)
print("SPRINT-1 VERIFICATION")
print("=" * 60)

for f in files:
    try:
        compile(open(f, encoding="utf-8").read(), f, "exec")
        print(f"[PASS] Syntax OK  — {f}")
    except SyntaxError as e:
        print(f"[FAIL] Syntax ERR — {f}  line {e.lineno}: {e.msg}")
        all_ok = False

print()
print("--- jobs.json validation ---")
cfg = json.load(open("data/jobs.json", encoding="utf-8"))
job = cfg["jobs"][0]

checks = [
    ("watch_time block present",         "watch_time" in job),
    ("engagement block present",         "engagement" in job),
    ("watch_time.mode = smart",          job["watch_time"]["mode"] == "smart"),
    ("watch_time.smart_min_pct = 0.40",  job["watch_time"]["smart_min_pct"] == 0.40),
    ("like.enabled = true",              job["engagement"]["like"]["enabled"] is True),
    ("like.probability = 0.85",          job["engagement"]["like"]["probability"] == 0.85),
    ("dislike.enabled = false",          job["engagement"]["dislike"]["enabled"] is False),
    ("subscribe.enabled = true",         job["engagement"]["subscribe"]["enabled"] is True),
    ("bell.enabled = true",              job["engagement"]["bell"]["enabled"] is True),
    ("comment.enabled = true",           job["engagement"]["comment"]["enabled"] is True),
    ("comment_templates >= 3",           len(job["engagement"]["comment"]["comment_templates"]) >= 3),
    ("autoplay_off.must_do = true",      job["engagement"]["autoplay_off"]["must_do"] is True),
    ("ads_skip.must_do = true",          job["engagement"]["ads_skip"]["must_do"] is True),
    ("ads_skip_after_seconds = 5",       job["engagement"]["ads_skip"]["skip_after_seconds"] == 5),
    ("quality.enabled = true",           job["engagement"]["quality"]["enabled"] is True),
    ("quality.target = 360p",            job["engagement"]["quality"]["target"] == "360p"),
]

for name, result in checks:
    status = "[PASS]" if result else "[FAIL]"
    print(f"  {status} {name}")
    if not result:
        all_ok = False

print()
print("--- Import test (EngagementConfig + WatchTimeConfig) ---")
try:
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location("types", "behavior/youtube/types.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    # Test WatchTimeConfig
    wt = mod.WatchTimeConfig(mode="smart", smart_min_pct=0.40, smart_max_pct=0.60)
    import random; rng = random.Random(42)
    result_90 = wt.resolve(300.0, rng)
    assert 90 <= result_90 <= 200, f"smart mode resolve out of range: {result_90}"
    print(f"  [PASS] WatchTimeConfig.resolve(300s) = {result_90:.0f}s  (expected 90-200s)")

    wt_medium = mod.WatchTimeConfig.default()
    result_medium = wt_medium.resolve(None, rng)
    assert 120 <= result_medium <= 180, f"medium fallback out of range: {result_medium}"
    print(f"  [PASS] WatchTimeConfig.default().resolve(None) = {result_medium:.0f}s  (expected 120-180s)")

    # Test EngagementAction T1-04 rule
    action_on = mod.EngagementAction(enabled=True, probability=1.0, must_do=True)
    assert action_on.should_attempt(rng) is True, "must_do=True should always return True"
    print("  [PASS] EngagementAction(must_do=True).should_attempt() = True  (T1-04)")

    action_off = mod.EngagementAction(enabled=False, probability=1.0)
    assert action_off.should_attempt(rng) is False, "enabled=False should always return False"
    print("  [PASS] EngagementAction(enabled=False).should_attempt() = False  (T1-04)")

    action_prob = mod.EngagementAction(enabled=True, probability=0.0)
    assert action_prob.should_attempt(rng) is False, "probability=0.0 should return False"
    print("  [PASS] EngagementAction(probability=0.0).should_attempt() = False  (T1-04)")

    # Test EngagementConfig.from_dict
    eng_data = job["engagement"]
    eng = mod.EngagementConfig.from_dict(eng_data)
    assert eng.like.enabled is True
    assert eng.dislike.enabled is False
    assert eng.autoplay_off.must_do is True
    assert eng.ads_skip.must_do is True
    assert len(eng.comment_templates) >= 3
    picked = eng.pick_comment(rng)
    assert picked and len(picked) > 5, f"comment pick failed: {picked}"
    print(f"  [PASS] EngagementConfig.from_dict() OK — sample comment: '{picked[:40]}...'")

    # Test comment_submit selector update
    spec2 = importlib.util.spec_from_file_location("selectors", "behavior/youtube/selectors.py")
    mod2 = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(mod2)
    cs = mod2.DESKTOP_SELECTORS["comment_submit"]["css"]
    assert any("yt-button-shape" in s for s in cs), "yt-button-shape selector missing"
    assert any('aria-label="Comment"' in s for s in cs), "aria-label Comment selector missing"
    print(f"  [PASS] comment_submit has {len(cs)} CSS selectors (incl. new yt-button-shape)")

except Exception as e:
    import traceback
    print(f"  [FAIL] Import/logic test: {e}")
    traceback.print_exc()
    all_ok = False

print()
print("=" * 60)
if all_ok:
    print("ALL SPRINT-1 CHECKS PASSED")
else:
    print("SOME CHECKS FAILED — see above")
print("=" * 60)
