"""
Sprint-1 Round-2 Verification — Logic + Edge Cases
Insaan ki tarah sochke: kya kya galat ho sakta hai?
"""
import sys, io, json, importlib.util, random, pathlib
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PASS = 0
FAIL = 0

def check(name, result, detail=""):
    global PASS, FAIL
    if result:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}" + (f"  →  {detail}" if detail else ""))

def load_mod(path):
    spec = importlib.util.spec_from_file_location(pathlib.Path(path).stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

types = load_mod("behavior/youtube/types.py")
WatchTimeConfig   = types.WatchTimeConfig
WatchTimeMode     = types.WatchTimeMode
EngagementConfig  = types.EngagementConfig
EngagementAction  = types.EngagementAction

rng = random.Random(99)

print("=" * 65)
print("ROUND-2: WatchTimeConfig — Edge Cases")
print("=" * 65)

# 1. Smart mode — very short video (< 30s) should fall back to medium
wt = WatchTimeConfig(mode="smart")
result = wt.resolve(10.0, rng)
check("Smart mode: video<30s falls back to medium range (120-180)",
      120 <= result <= 180, f"got {result:.1f}")

# 2. Smart mode — video exactly 30s boundary
result2 = wt.resolve(30.0, rng)
# dur=30 is NOT > 30, so fallback
check("Smart mode: video=30s (boundary) falls back",
      120 <= result2 <= 180, f"got {result2:.1f}")

# 3. Smart mode — video=31s should use percentage
result3 = wt.resolve(31.0, rng)
# 40-60% of 31s = 12.4-18.6s, but min 60s → should return 60
check("Smart mode: video=31s → clamped to min 60s",
      result3 == 60.0, f"got {result3:.1f}")

# 4. Smart mode — normal 300s video
result4 = wt.resolve(300.0, rng)
check("Smart mode: 300s video → 60-295s range",
      60.0 <= result4 <= 295.0, f"got {result4:.1f}")

# 5. Fixed mode ignores duration completely
wt_fixed = WatchTimeConfig(mode="fixed", fixed_seconds=150.0)
result5 = wt_fixed.resolve(999.0, rng)
check("Fixed mode: always returns fixed_seconds=150",
      result5 == 150.0, f"got {result5:.1f}")

# 6. None duration → should not crash
wt_med = WatchTimeConfig(mode="medium")
result6 = wt_med.resolve(None, rng)
check("Medium mode: duration=None → no crash, returns 120-180",
      120 <= result6 <= 180, f"got {result6:.1f}")

# 7. Invalid mode string → auto-correct to medium
wt_bad = WatchTimeConfig(mode="garbage_mode")
check("Invalid mode: auto-corrected to medium",
      wt_bad.mode == WatchTimeMode.MEDIUM, f"got {wt_bad.mode!r}")

# 8. min > max sanity → auto-fix
wt_inv = WatchTimeConfig(mode="medium", min_seconds=200.0, max_seconds=100.0)
check("min>max: auto-fixed (max >= min+10)",
      wt_inv.max_seconds >= wt_inv.min_seconds + 10, f"min={wt_inv.min_seconds} max={wt_inv.max_seconds}")

# 9. smart_min_pct >= smart_max_pct → auto-fix
wt_pct = WatchTimeConfig(mode="smart", smart_min_pct=0.80, smart_max_pct=0.50)
check("smart_min>smart_max: auto-fixed",
      wt_pct.smart_max_pct >= wt_pct.smart_min_pct + 0.05,
      f"min={wt_pct.smart_min_pct} max={wt_pct.smart_max_pct}")

print()
print("=" * 65)
print("ROUND-2: EngagementAction — T1-04 Rule Exhaustive")
print("=" * 65)

# 10. enabled=False + must_do=True → still False (disabled overrides everything)
a = EngagementAction(enabled=False, probability=1.0, must_do=True)
check("T1-04: enabled=False overrides must_do=True → False",
      a.should_attempt(rng) is False)

# 11. enabled=True + must_do=True + probability=0.0 → True (must_do wins)
a2 = EngagementAction(enabled=True, probability=0.0, must_do=True)
check("T1-04: enabled=True + must_do=True + prob=0.0 → True",
      a2.should_attempt(rng) is True)

# 12. enabled=True + probability=0.0 → always False
a3 = EngagementAction(enabled=True, probability=0.0, must_do=False)
results = [a3.should_attempt(rng) for _ in range(100)]
check("T1-04: probability=0.0 → always False (100 rolls)",
      all(r is False for r in results))

# 13. enabled=True + probability=1.0 → always True
a4 = EngagementAction(enabled=True, probability=1.0, must_do=False)
results4 = [a4.should_attempt(rng) for _ in range(100)]
check("T1-04: probability=1.0 → always True (100 rolls)",
      all(r is True for r in results4))

# 14. bool shorthand: true → enabled=True, must_do=True
a5 = EngagementAction.from_dict(True)
check("from_dict(True): enabled=True, must_do=True",
      a5.enabled is True and a5.must_do is True)

# 15. bool shorthand: false → enabled=False
a6 = EngagementAction.from_dict(False)
check("from_dict(False): enabled=False",
      a6.enabled is False)

print()
print("=" * 65)
print("ROUND-2: EngagementConfig — from_dict Edge Cases")
print("=" * 65)

# 16. Empty dict → defaults (no crash)
eng_empty = EngagementConfig.from_dict({})
check("Empty dict → no crash, returns defaults",
      eng_empty.like.enabled is True)  # default like=True

# 17. comment_templates inside 'comment' block → correctly parsed
eng_data_inner = {
    "comment": {
        "enabled": True,
        "probability": 0.5,
        "comment_templates": ["Hello world", "Great video!"]
    }
}
eng_inner = EngagementConfig.from_dict(eng_data_inner)
check("comment_templates inside 'comment' block → parsed correctly",
      len(eng_inner.comment_templates) == 2,
      f"got {eng_inner.comment_templates}")

# 18. comment_templates at top-level → also works
eng_data_top = {
    "comment": {"enabled": True},
    "comment_templates": ["Top level comment"]
}
eng_top = EngagementConfig.from_dict(eng_data_top)
check("comment_templates at top-level → parsed correctly",
      len(eng_top.comment_templates) == 1,
      f"got {eng_top.comment_templates}")

# 19. pick_comment with empty pool → returns fallback
eng_no_comments = EngagementConfig.from_dict({"comment": {"enabled": True}})
picked = eng_no_comments.pick_comment(rng, fallback="fallback text")
check("pick_comment: empty pool → returns fallback",
      picked == "fallback text", f"got {picked!r}")

# 20. pick_comment with pool → returns from pool
eng_with = EngagementConfig.from_dict({
    "comment": {"enabled": True, "comment_templates": ["A", "B", "C"]}
})
picked2 = eng_with.pick_comment(rng)
check("pick_comment: pool available → returns from pool",
      picked2 in ["A", "B", "C"], f"got {picked2!r}")

# 21. quality block: disabled → quality_enabled=False
eng_q = EngagementConfig.from_dict({"quality": {"enabled": False, "target": "720p"}})
check("quality.enabled=False → quality_enabled=False",
      eng_q.quality_enabled is False)

# 22. quality block: target preserved
eng_q2 = EngagementConfig.from_dict({"quality": {"enabled": True, "target": "720p"}})
check("quality.target=720p → preserved",
      eng_q2.quality_target == "720p")

# 23. ads_skip_after_seconds correctly parsed
eng_ads = EngagementConfig.from_dict({
    "ads_skip": {"enabled": True, "must_do": True, "skip_after_seconds": 8}
})
check("ads_skip_after_seconds=8 → parsed correctly",
      eng_ads.ads_skip_after_seconds == 8, f"got {eng_ads.ads_skip_after_seconds}")

print()
print("=" * 65)
print("ROUND-2: Selectors — comment_submit coverage")
print("=" * 65)

sels = load_mod("behavior/youtube/selectors.py")
cs = sels.DESKTOP_SELECTORS["comment_submit"]["css"]

check("comment_submit: >= 5 CSS selectors",   len(cs) >= 5, f"got {len(cs)}")
check("yt-button-shape selector present",      any("yt-button-shape" in s for s in cs))
check("classic #submit-button button present", "#submit-button button" in cs)
check("aria-label Comment selector present",   any('aria-label="Comment"' in s for s in cs))
check("ytd-button-renderer selector present",  any("ytd-button-renderer" in s for s in cs))
check("aria_labels field = ('Comment',)",
      sels.DESKTOP_SELECTORS["comment_submit"].get("aria_labels") == ("Comment",))

print()
print("=" * 65)
print("ROUND-2: jobs.json — Full Validation")
print("=" * 65)

cfg = json.load(open("data/jobs.json", encoding="utf-8"))
job = cfg["jobs"][0]
eng = job["engagement"]
wt  = job["watch_time"]

check("referrer_search = false",    job["referrer_search"] is False)
check("watch_time.mode = smart",    wt["mode"] == "smart")
check("watch_time.smart_min_pct",   wt["smart_min_pct"] == 0.40)
check("watch_time.smart_max_pct",   wt["smart_max_pct"] == 0.60)
check("watch_time.min_seconds=90",  wt["min_seconds"] == 90)
check("engagement.like.prob=0.85",  eng["like"]["probability"] == 0.85)
check("engagement.dislike=false",   eng["dislike"]["enabled"] is False)
check("engagement.sub.prob=0.30",   eng["subscribe"]["probability"] == 0.30)
check("engagement.bell.prob=0.50",  eng["bell"]["probability"] == 0.50)
check("engagement.comment.prob=0.40", eng["comment"]["probability"] == 0.40)
check(">= 10 comment templates",    len(eng["comment"]["comment_templates"]) >= 10)
check("autoplay_off.must_do",       eng["autoplay_off"]["must_do"] is True)
check("ads_skip.must_do",           eng["ads_skip"]["must_do"] is True)
check("ads_skip_after_seconds=5",   eng["ads_skip"]["skip_after_seconds"] == 5)
check("quality.enabled=true",       eng["quality"]["enabled"] is True)
check("quality.target=360p",        eng["quality"]["target"] == "360p")
check("description.enabled=false",  eng["description"]["enabled"] is False)

print()
print("=" * 65)
print(f"ROUND-2 RESULT:  {PASS} PASS  |  {FAIL} FAIL")
print("=" * 65)
if FAIL == 0:
    print("ALL ROUND-2 CHECKS PASSED")
else:
    print("FAILURES FOUND — fix before proceeding")
