"""Per-profile SHA-256 search keywords — never video_id / URL."""
from __future__ import annotations

from server_python.search_keyword_planner import (
    build_profile_search_pool,
    build_search_attempt_plan,
    exact_match_fallback_keywords,
    filter_keyword_pool,
    is_invalid_search_text,
    keyword_seed_hex,
    primary_search_keyword,
    validate_search_keyword,
    verify_keyword_pool,
)


VIDEO_ID = "dQw4w9WgXcQ"
TITLE = "How to Grow YouTube Channel Fast in 2026"
CHANNEL = "Creator Academy India"


def test_never_uses_video_id_as_keyword():
    pool = build_profile_search_pool("profile-a", VIDEO_ID, TITLE, CHANNEL)
    assert pool, "expected keywords from title"
    for kw in pool:
        assert VIDEO_ID not in kw
        assert not is_invalid_search_text(kw)


def test_different_profiles_get_different_keywords():
    p1 = build_profile_search_pool("profile-aaa-111", VIDEO_ID, TITLE, CHANNEL)
    p2 = build_profile_search_pool("profile-bbb-222", VIDEO_ID, TITLE, CHANNEL)
    p3 = build_profile_search_pool("profile-ccc-333", VIDEO_ID, TITLE, CHANNEL)
    assert p1 and p2 and p3
    # At least two profiles should differ on first keyword
    firsts = {p[0] for p in (p1, p2, p3)}
    assert len(firsts) >= 2, f"expected diversity, got {firsts}"


def test_same_profile_same_day_is_deterministic():
    a = build_profile_search_pool("stable-profile", VIDEO_ID, TITLE, CHANNEL)
    b = build_profile_search_pool("stable-profile", VIDEO_ID, TITLE, CHANNEL)
    assert a == b


def test_session_nonce_changes_keywords():
    base = build_profile_search_pool("stable-profile", VIDEO_ID, TITLE, CHANNEL)
    alt = build_profile_search_pool(
        "stable-profile", VIDEO_ID, TITLE, CHANNEL, session_nonce="job-1|v0",
    )
    assert base != alt


def test_primary_keyword_not_video_id():
    kw = primary_search_keyword("prof-x", VIDEO_ID, TITLE, CHANNEL)
    assert kw
    assert VIDEO_ID not in kw
    assert not is_invalid_search_text(kw)


def test_invalid_search_text_rejects_url_and_id():
    assert is_invalid_search_text(VIDEO_ID)
    assert is_invalid_search_text(f"https://youtu.be/{VIDEO_ID}")
    assert is_invalid_search_text("video")
    assert not is_invalid_search_text(TITLE)


def test_exact_fallback_keywords_order():
    title = "How to Grow YouTube Channel Fast in 2026"
    channel = "Creator Academy India"
    fb = exact_match_fallback_keywords(title, channel)
    assert len(fb) >= 2
    assert fb[0] == title
    assert channel in fb[1]
    assert title in fb[1]


def test_build_search_attempt_plan_separates_fallbacks():
    title = "How to Grow YouTube Channel Fast in 2026"
    channel = "Creator Academy India"
    vid = "dQw4w9WgXcQ"
    primary, fallbacks = build_search_attempt_plan("prof-1", vid, title, channel)
    assert primary
    assert fallbacks
    assert fallbacks[0] == title
    assert title in fallbacks[1] and channel in fallbacks[1]
    for p in primary:
        assert p.lower() not in {f.lower() for f in fallbacks}


def test_seed_hex_includes_profile_and_video():
    s1 = keyword_seed_hex("p1", VIDEO_ID)
    s2 = keyword_seed_hex("p2", VIDEO_ID)
    s3 = keyword_seed_hex("p1", "abcdefghijk")
    assert s1 != s2
    assert s1 != s3


def test_validate_search_keyword_rejects_id_generic_and_unrelated():
    assert not validate_search_keyword(VIDEO_ID, TITLE, CHANNEL)
    assert not validate_search_keyword("random pizza recipe", TITLE, CHANNEL)
    assert not validate_search_keyword("best bank", TITLE, CHANNEL)
    assert not validate_search_keyword("quick tips", TITLE, CHANNEL)
    assert validate_search_keyword("grow youtube channel fast", TITLE, CHANNEL)


def test_filter_keyword_pool_dedupes_and_verifies():
    raw = [
        "grow youtube channel fast",
        "grow youtube channel fast",
        "best bank",
        "how to grow youtube channel",
    ]
    out = filter_keyword_pool(raw, TITLE, CHANNEL)
    assert "best bank" not in out
    assert len(out) == 2


def test_verify_keyword_pool_audit():
    report = verify_keyword_pool(
        ["grow youtube channel fast", "best bank"], TITLE, CHANNEL,
    )
    assert report["ok"] == 1
    assert report["rejected"] == ["best bank"]
    assert not report["passed"]


def test_persona_pool_min_three_words_when_title_allows():
    pool = build_profile_search_pool("profile-a", VIDEO_ID, TITLE, CHANNEL)
    assert pool, "expected persona keywords from title"
    for kw in pool:
        assert len(kw.split()) >= 3, f"too short/generic: {kw!r}"
        assert validate_search_keyword(kw, TITLE, CHANNEL)
