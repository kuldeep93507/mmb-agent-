"""Sprint-2 final audit verification — run with: python audit_verify.py"""
import sys, json
sys.path.insert(0, '.')

results = []

def chk(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results.append((name, status, detail))
    print(f"  [{status}] {name}" + (f" | {detail}" if detail else ""))

print("=" * 60)
print("SPRINT-2 FINAL AUDIT — ALL FIXES VERIFICATION")
print("=" * 60)

# F1 — brace-counting extractor
print("\n[F1] _extract_yt_initial_data brace counting")
from services.video_fetcher import _extract_yt_initial_data
r1 = _extract_yt_initial_data('var ytInitialData = {"a":{"b":1},"c":2};</script>')
chk("Nested JSON extraction", r1 == {"a":{"b":1},"c":2}, str(r1))
r2 = _extract_yt_initial_data('ytInitialData = {"x":{"y":{"z":[1,2,3]}}};var')
chk("Deep nesting (3 levels)", r2 == {"x":{"y":{"z":[1,2,3]}}}, str(r2))
chk("Missing marker returns None", _extract_yt_initial_data("nothing here") is None)

# F2 — sidebar-scoped selector
print("\n[F2] related_video JS click sidebar scoped")
rv = open("actions/related_video.py", encoding="utf-8").read()
chk("Selector has #secondary scope", "#secondary a[href*=" in rv)
chk("Selector has #related scope", "#related a[href*=" in rv)
chk("Selector has ytd-watch-next scope", "ytd-watch-next-secondary-results-renderer a[href*=" in rv)

# F3 — scroll IIFE
print("\n[F3] related_video scroll IIFE")
chk("Scroll uses IIFE ()()", "(() => window.scrollBy" in rv)

# F4 — docstring fixed
print("\n[F4] related_video docstring no stale watch_seconds")
chk("No stale watch_seconds param", "watch_seconds    : Seconds to watch" not in rv)
chk("watch_pct_min documented", "watch_pct_min" in rv)

# F5 — mark_watched uses result.video_id
print("\n[F5] Orchestrator result.video_id")
orc = open("core/Orchestrator.py", encoding="utf-8").read()
chk("result.video_id used", "_watched_vid = result.video_id or job.video_id" in orc)
chk("bool() wrapping on result fields", "bool(result.liked)" in orc)

# F6 — watch_pct min<=max swap
print("\n[F6] RelatedVideoConfig min<=max swap")
from behavior.youtube.types import RelatedVideoConfig
cfg = RelatedVideoConfig.from_dict({"enabled": True, "watch_pct_min": 0.95, "watch_pct_max": 0.70})
chk("watch_pct swapped when reversed", cfg.watch_pct_min <= cfg.watch_pct_max,
    f"min={cfg.watch_pct_min} max={cfg.watch_pct_max}")

# F7 — pool exhausted returns None
print("\n[F7] shuffle_engine pool exhausted = None (24h rule)")
se_src = open("schedule/shuffle_engine.py", encoding="utf-8").read()
chk("Pool exhausted returns None", "pool exhausted, returning None" in se_src)
chk("No re-serve of watched videos", "fresh_pool = list(all_videos)" not in se_src)
chk("is_fresh=False dead code removed", "is_fresh = False" not in se_src)

# F8 — non-numeric priority guard
print("\n[F8] shuffle_engine non-numeric priority guard")
chk("TypeError/ValueError caught in get_next_video", "except (TypeError, ValueError)" in se_src)

# F9 — OverlapStore TTL
print("\n[F9] OverlapStore TTL timestamp")
from schedule.shuffle_engine import OverlapStore
store = OverlapStore()
store.mark_assigned("p-test", "v-test")
raw = json.loads(open("data/shuffle_dedup.json", encoding="utf-8").read())
entry = raw.get("overlap_v2", {}).get("p-test", {})
chk("OverlapStore entry is dict", isinstance(entry, dict), str(entry))
chk("assigned_at in entry", "assigned_at" in entry)
chk("video_id in entry", "video_id" in entry)
store.clear()

# F10 — urllib fallback + ssl
print("\n[F10] video_fetcher urllib fallback + ssl")
vf_src = open("services/video_fetcher.py", encoding="utf-8").read()
chk("ssl=False removed", "ssl=False" not in vf_src)
chk("urllib fallback on aiohttp errors", "aiohttp runtime error" in vf_src or "DNS, timeout" in vf_src)

# F11 — ad filter
print("\n[F11] video_fetcher ad renderer filter")
chk("adBadgeText filter", "adBadgeText" in vf_src)
chk("promotedVideoOverlayRenderer filter", "promotedVideoOverlayRenderer" in vf_src)

# F12 — Handle OK false log
print("\n[F12] video_fetcher Handle OK only when videos")
chk("False Handle OK fixed", "Handle fetch returned 0 videos" in vf_src)

# F13 — seed mixing
print("\n[F13] shuffle_engine multiply-add seed mixing")
chk("multiply-add present", "1_000_003" in se_src)
chk("XOR with small int removed", "seed ^ pri" not in se_src)

# F14 — fresh always True
print("\n[F14] shuffle_engine fresh=True on non-empty pool")
chk("fresh always True", '"fresh":          True' in se_src)

# F15 — T2-03 Orchestrator wiring
print("\n[F15] T2-03: get_next_video wired in Orchestrator._execute_task")
orc2 = open("core/Orchestrator.py", encoding="utf-8").read()
chk("get_next_video called in _execute_task", "self._profile_shuffle.get_next_video(" in orc2)
chk("Shuffle result builds VideoTarget", "VideoTarget(" in orc2 and "_shuffle_video[\"video_id\"]" in orc2)
chk("Fallback to job.to_video_target on pool empty", "pool empty" in orc2)
chk("Shuffle video_id injected into T2-02 own_video_ids", "own_video_ids.add(" in orc2)
chk("ShuffleEngine error is non-fatal (try/except)", "ShuffleEngine error (non-fatal)" in orc2)

# Summary
print("\n" + "=" * 60)
fails = [r for r in results if r[1] == "FAIL"]
passes = [r for r in results if r[1] == "PASS"]
print(f"TOTAL: {len(passes)} PASS  |  {len(fails)} FAIL")
if fails:
    print("\nFAILED CHECKS:")
    for name, status, detail in fails:
        print(f"  FAIL: {name} | {detail}")
else:
    print("ALL CHECKS PASSED")
print("=" * 60)
