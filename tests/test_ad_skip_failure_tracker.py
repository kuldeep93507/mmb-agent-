"""Ad-skip failure tracker — record, threshold, clear on heal."""
from server_python import ad_skip_failure_tracker as tracker


def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(tracker, "_FAILURES_FILE", tmp_path / "fails.json")


def test_record_and_threshold(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    assert tracker.count_recent() == 0
    assert tracker.needs_healing() is False

    tracker.record_failure("SKIP_UI_BUT_NOT_VERIFIED", {"skipCandidates": [{"id": "x"}]})
    tracker.record_failure("TIMEOUT verified_skips=0", {})
    assert tracker.count_recent() == 2
    assert tracker.needs_healing() is False

    n = tracker.record_failure("SKIP_UI_BUT_NOT_VERIFIED", {})
    assert n == 3
    assert tracker.needs_healing() is True

    status = tracker.get_status()
    assert status["count24h"] == 3
    assert status["needsHealing"] is True
    assert status["lastProof"].startswith("SKIP_UI")


def test_latest_dom_dump_prefers_candidates(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    tracker.record_failure("A", {"skipCandidates": [{"id": "good"}]})
    tracker.record_failure("B", {})  # empty dump — skip over it
    dump = tracker.latest_dom_dump()
    assert "good" in dump


def test_clear_resets(tmp_path, monkeypatch):
    _isolate(tmp_path, monkeypatch)
    tracker.record_failure("A", {})
    tracker.clear()
    assert tracker.count_recent() == 0
    assert tracker.get_status()["totalRecorded"] == 0
