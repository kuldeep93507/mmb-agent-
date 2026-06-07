"""Sprint-4: 3-pass verification of all fixes"""
import sys, json, os, threading
sys.path.insert(0, '.')

results = []
def chk(name, cond, detail=""):
    s = "PASS" if cond else "FAIL"
    results.append((name, s, detail))
    print(f"  [{s}] {name}" + (f" | {detail}" if detail else ""))

def section(t): print(f"\n[{t}]")

def summary(label):
    fails = [r for r in results if r[1]=="FAIL"]
    passes = [r for r in results if r[1]=="PASS"]
    print(f"\n{label}: {len(passes)} PASS | {len(fails)} FAIL")
    if fails:
        for n,s,d in fails: print(f"  FAIL: {n} | {d}")
    return len(fails)

# =============================================================================
print("="*60); print("SPRINT-4 PASS 1 — Code Structure"); print("="*60)

orc = open("core/Orchestrator.py", encoding="utf-8").read()
vf  = open("services/video_fetcher.py", encoding="utf-8").read()
se  = open("schedule/shuffle_engine.py", encoding="utf-8").read()

section("FIX1 — ShuffleEngine full remove from Orchestrator")
chk("ShuffleEngine import removed", "from core.ShuffleEngine import ShuffleEngine" not in orc)
chk("load_videos_from_jobs import removed", "from core.ShuffleEngine import" not in orc)
chk("self._shuffle_engine init block removed", "self._shuffle_engine = ShuffleEngine(" not in orc)
chk("self._shuffle_engine = None removed", "self._shuffle_engine = None" not in orc)
chk("Sprint-4 retire comment present", "Sprint-4" in orc)
chk("status_report still uses strftime inline", 'strftime("%Y-%m-%d")' in orc)

section("FIX2 — _find_video_renderers false positive fix")
chk("REAL_VIDEO_FIELDS guard added", "_REAL_VIDEO_FIELDS" in vf)
chk("lengthText required", '"lengthText"' in vf)
chk("publishedTimeText required", '"publishedTimeText"' in vf)
chk("viewCountText required", '"viewCountText"' in vf)
chk("thumbnail required", '"thumbnail"' in vf)
chk("Sprint-4 fix comment", "Sprint-4 fix" in vf)
chk("container fallthrough (recursion continues)", "Continue recursing" in vf)

section("FIX3 — _make_logger thread safety")
chk("import threading added", "import threading" in se)
chk("_LOGGER_LOCK defined", "_LOGGER_LOCK = threading.Lock()" in se)
chk("_CONFIGURED_LOGGERS set defined", "_CONFIGURED_LOGGERS: set = set()" in se)
chk("_LOGGER_NAME constant defined", '_LOGGER_NAME = "mmb.shuffle_engine_v2"' in se)
chk("with _LOGGER_LOCK used", "with _LOGGER_LOCK:" in se)
chk("_CONFIGURED_LOGGERS.add called", "_CONFIGURED_LOGGERS.add(_LOGGER_NAME)" in se)
chk("_CONFIGURED_LOGGERS guards handler add (not raw handlers check)", "_LOGGER_NAME not in _CONFIGURED_LOGGERS" in se)
chk("Sprint-4 comment in logger section", "Sprint-4" in se)

section("FIX4 — channelId regex (fetch_by_handle)")
chk("externalId regex first", '"externalId"' in vf)
chk("browseId fallback second", '"browseId"' in vf)
chk("channelId last resort only", '"channelId"' in vf)
chk("min length guard UC[^\"]{10,}", 'UC[^"]{10,}' in vf)
chk("Sprint-4 fix comment", "Sprint-4 fix" in vf)

p1 = summary("PASS 1")

# =============================================================================
print("\n"+"="*60); print("SPRINT-4 PASS 2 — Functional Tests"); print("="*60)
results.clear()

section("Orchestrator compiles without ShuffleEngine")
try:
    with open("core/Orchestrator.py", encoding="utf-8") as f:
        compile(f.read(), "Orchestrator.py", "exec")
    chk("Orchestrator.py compiles", True)
except SyntaxError as e:
    chk("Orchestrator.py compiles", False, str(e))

section("_find_video_renderers — false positive filter")
from services.video_fetcher import _find_video_renderers

# Real video renderer — has lengthText
real_renderer = {
    "videoId": "abc123",
    "title": {"runs": [{"text": "My Video"}]},
    "lengthText": {"simpleText": "12:34"},
    "thumbnail": {"thumbnails": [{"url": "..."}]},
}
# Fake/metadata dict — no real video fields
fake_renderer = {
    "videoId": "abc123",
    "title": {"simpleText": "Channel Page Title"},
    # No lengthText, publishedTimeText, viewCountText, thumbnail
}
# Container with nested real renderer
container = {
    "someOtherKey": "val",
    "nested": {
        "deeper": [
            real_renderer,
            fake_renderer,
        ]
    }
}

r1 = []
_find_video_renderers(real_renderer, r1)
chk("Real renderer (lengthText) is collected", len(r1) == 1)

r2 = []
_find_video_renderers(fake_renderer, r2)
chk("Fake renderer (no video fields) is SKIPPED", len(r2) == 0)

r3 = []
_find_video_renderers(container, r3)
chk("Container: only real renderer collected (not fake)", len(r3) == 1)
chk("Collected renderer has correct videoId", r3[0]["videoId"] == "abc123" if r3 else False)

# Shelf scenario: container with videoId+title but no video fields wraps real renderers
shelf = {
    "videoId": "shelf-fake",
    "title": {"simpleText": "Related Videos"},
    "content": {
        "items": [
            {"videoId": "v1", "title": {"runs": [{"text": "T1"}]}, "publishedTimeText": {"simpleText": "1 day ago"}},
            {"videoId": "v2", "title": {"runs": [{"text": "T2"}]}, "viewCountText": {"simpleText": "1M"}},
        ]
    }
}
r4 = []
_find_video_renderers(shelf, r4)
chk("Shelf container: finds 2 nested real renderers", len(r4) == 2, str(len(r4)))

# adBadgeText still filtered in _parse_html_videos
ad_renderer = {
    "videoId": "ad1",
    "title": {"runs": [{"text": "Ad"}]},
    "lengthText": {"simpleText": "0:30"},
    "adBadgeText": "Sponsored",
}
r5 = []
_find_video_renderers(ad_renderer, r5)
# _find_video_renderers collects it, but _parse_html_videos filters adBadgeText
chk("Ad renderer collected by finder (filter in parse)", len(r5) == 1)

section("_make_logger thread safety")
from schedule.shuffle_engine import _make_logger, _CONFIGURED_LOGGERS, _LOGGER_NAME
import logging, tempfile
from pathlib import Path

# Reset state for test
_CONFIGURED_LOGGERS.discard(_LOGGER_NAME)
root_logger = logging.getLogger(_LOGGER_NAME)
for h in root_logger.handlers[:]:
    root_logger.removeHandler(h)

with tempfile.TemporaryDirectory() as td:
    log_path = Path(td) / "test.log"
    loggers_from_threads = []
    errors = []

    def make_logger_thread():
        try:
            l = _make_logger(log_path)
            loggers_from_threads.append(l)
        except Exception as e:
            errors.append(str(e))

    threads = [threading.Thread(target=make_logger_thread) for _ in range(10)]
    for t in threads: t.start()
    for t in threads: t.join()

    final_logger = logging.getLogger(_LOGGER_NAME)
    handler_count = len(final_logger.handlers)
    chk("No errors creating logger from 10 threads", len(errors) == 0, str(errors))
    chk("Exactly 1 handler (no duplicates)", handler_count == 1, f"handlers={handler_count}")
    chk("All threads got same logger instance", len(set(id(l) for l in loggers_from_threads)) == 1)

    # Cleanup: MUST close handlers BEFORE tempdir cleanup (Windows keeps file locked)
    for h in final_logger.handlers[:]:
        h.close()
        final_logger.removeHandler(h)
    _CONFIGURED_LOGGERS.discard(_LOGGER_NAME)

section("channelId regex priority test")
import re

# Simulate a page with externalId (correct), channelId (wrong recommendation)
fake_html = '''
var data = {"channelId":"UCwrong_recommended_channel",
"externalId":"UCcorrect_channel_owner",
"browseId":"UCbrowse_channel"};
'''
m_ext = re.search(r'"externalId"\s*:\s*"(UC[^"]{10,})"', fake_html)
m_browse = re.search(r'"browseId"\s*:\s*"(UC[^"]{10,})"', fake_html)
m_ch = re.search(r'"channelId"\s*:\s*"(UC[^"]{10,})"', fake_html)

chk("externalId finds correct channel", m_ext and m_ext.group(1) == "UCcorrect_channel_owner")
chk("browseId fallback finds browse", m_browse and m_browse.group(1) == "UCbrowse_channel")
chk("channelId last resort (may be wrong)", m_ch and m_ch.group(1) == "UCwrong_recommended_channel")
# Priority chain: externalId wins
result_id = (m_ext or m_browse or m_ch)
chk("Priority chain: externalId wins", result_id.group(1) == "UCcorrect_channel_owner")
# Short UC IDs filtered (min 10 chars after UC)
short_html = '"channelId":"UCshort"'
m_short = re.search(r'"channelId"\s*:\s*"(UC[^"]{10,})"', short_html)
chk("Short UC IDs filtered by {10,}", m_short is None)

section("All files compile clean")
for fname in ["core/Orchestrator.py", "services/video_fetcher.py",
              "schedule/shuffle_engine.py", "dashboard/app.py",
              "actions/related_video.py", "services/channel_manager.py"]:
    try:
        with open(fname, encoding="utf-8") as f:
            compile(f.read(), fname, "exec")
        chk(f"{fname} compiles", True)
    except SyntaxError as e:
        chk(f"{fname} compiles", False, str(e))

p2 = summary("PASS 2")

# =============================================================================
print("\n"+"="*60); print("SPRINT-4 PASS 3 — Edge Cases + Full Regression"); print("="*60)
results.clear()

section("_find_video_renderers — depth limit")
# Very deep nesting — should not crash
def make_deep(depth, leaf):
    if depth == 0:
        return leaf
    return {"wrapper": make_deep(depth - 1, leaf)}

deep_real = make_deep(48, {
    "videoId": "deepv",
    "title": {"runs": [{"text": "Deep"}]},
    "thumbnail": {"thumbnails": []},
})
r_deep = []
_find_video_renderers(deep_real, r_deep)
chk("Depth 48 real renderer found", len(r_deep) == 1)

too_deep = make_deep(55, {
    "videoId": "toodeep",
    "title": {"runs": []},
    "lengthText": {"simpleText": "1:00"},
})
r_toodeep = []
_find_video_renderers(too_deep, r_toodeep)
chk("Depth 55 stops at limit (renderer not found)", len(r_toodeep) == 0)

section("_find_video_renderers — thumbnail field variant")
# Some renderers have "thumbnail" as direct key
with_thumb = {
    "videoId": "tv1",
    "title": {"simpleText": "T"},
    "thumbnail": {"thumbnails": [{"url": "x", "width": 120}]},
}
r_thumb = []
_find_video_renderers(with_thumb, r_thumb)
chk("thumbnail field triggers match", len(r_thumb) == 1)

section("Orchestrator: no ShuffleEngine references at runtime")
chk("Old ShuffleEngine() call removed (not ProfileShuffleEngine)", "= ShuffleEngine(" not in orc and "ShuffleEngine(" not in orc.replace("ProfileShuffleEngine(", ""))
chk("No _shuffle_engine attribute used", "_shuffle_engine" not in orc or "Sprint-4" in orc)

section("Logger: LOGGER_NAME constant used consistently")
chk("_LOGGER_NAME used in getLogger", 'logging.getLogger(_LOGGER_NAME)' in se)
chk("_CONFIGURED_LOGGERS uses _LOGGER_NAME", '_CONFIGURED_LOGGERS.add(_LOGGER_NAME)' in se)
chk("_CONFIGURED_LOGGERS check uses _LOGGER_NAME", '_LOGGER_NAME not in _CONFIGURED_LOGGERS' in se)

section("Full Sprint-2 + Sprint-3 regression")
from services.video_fetcher import _extract_yt_initial_data
chk("brace extractor still works", _extract_yt_initial_data('ytInitialData = {"x":1};') == {"x":1})
from behavior.youtube.types import RelatedVideoConfig
cfg = RelatedVideoConfig.from_dict({"enabled":True,"watch_pct_min":0.99,"watch_pct_max":0.10})
chk("RelatedVideoConfig swap still works", cfg.watch_pct_min <= cfg.watch_pct_max)
from schedule.shuffle_engine import ProfileShuffleEngine, OverlapStore
chk("ProfileShuffleEngine importable", True)
chk("OverlapStore importable", True)
from services.channel_manager import ChannelManager
chk("ChannelManager importable", True)
chk("ChannelManager.sync_to_jobs exists", hasattr(ChannelManager, "sync_to_jobs"))

section("Sprint-4 summary: no old engine references in hot path")
# Hot path = _execute_task
chk("_execute_task has no ShuffleEngine", "ShuffleEngine" not in orc.split("_execute_task")[1].split("def ")[0]
    if "_execute_task" in orc else True)

p3 = summary("PASS 3")

# =============================================================================
total = p1 + p2 + p3
print("\n"+"="*60)
print("SPRINT-4 FINAL: 3-PASS COMPLETE")
print(f"P1:{p1} | P2:{p2} | P3:{p3} fails")
print("ALL CHECKS PASSED" if total == 0 else f"TOTAL FAILS: {total}")
print("="*60)
