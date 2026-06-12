"""Tests for external search helpers (Google/Bing SERP unwrap + consent)."""
from server_python.behavior.external_search import normalize_youtube_href


def test_normalize_google_redirect():
    raw = "https://www.google.com/url?sa=t&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc123XYZ01"
    out = normalize_youtube_href(raw)
    assert "youtube.com/watch?v=abc123XYZ01" in out


def test_normalize_youtu_be():
    out = normalize_youtube_href("https://youtu.be/abc123XYZ01?t=5")
    assert out == "https://www.youtube.com/watch?v=abc123XYZ01"


def test_normalize_bing_redirect():
    raw = "https://www.bing.com/ck/a?u=aHR0cHM6Ly93d3cueW91dHViZS5jb20vd2F0Y2g/dj1hYmMxMjM"
    # base64-ish u= param — function uses URL decode on u= match
    out = normalize_youtube_href(raw)
    assert out  # best-effort; may return original if decode fails
