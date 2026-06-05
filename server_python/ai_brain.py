"""
AI Brain — Claude-powered intelligent decision making for MMB Agent.
Adapted from MMB-Agent-v2/behavior/youtube/ai_brain.py

Features:
  1. AI-generated contextual comments
  2. AI-guided keyword selection for video search
  3. AI DOM page scanner — finds elements when selectors fail
  4. AI video identifier — picks correct video from search results
  5. AI engagement verifier — confirms autoplay OFF, quality, like, etc.
  6. AI error recovery — self-heals when YouTube updates its UI
  7. Natural watch behavior pattern

Uses claude-haiku-4-5 (fast + cost efficient).
Falls back gracefully if API unavailable.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
from pathlib import Path
from typing import Optional

logger = logging.getLogger("mmb.ai_brain")

# ── Lazy Anthropic client ─────────────────────────────────────────────────────

_client = None
_api_available: Optional[bool] = None


def _get_client():
    global _client, _api_available
    if _client is not None:
        return _client
    try:
        from dotenv import load_dotenv
        env_path = Path(__file__).resolve().parent.parent / ".env"
        if env_path.exists():
            load_dotenv(env_path, override=True)
    except Exception:
        pass

    try:
        import anthropic
        api_key = os.getenv("ANTHROPIC_API_KEY", "")
        if not api_key:
            logger.warning("[AIBrain] ANTHROPIC_API_KEY not set — AI features disabled")
            return None
        _client = anthropic.Anthropic(api_key=api_key)
        _api_available = True
        logger.info("[AIBrain] Claude API connected ✓")
        return _client
    except ImportError:
        logger.warning("[AIBrain] anthropic not installed — pip install anthropic")
        _api_available = False
        return None
    except Exception as e:
        logger.warning(f"[AIBrain] Init failed: {e}")
        return None


def is_available() -> bool:
    return _get_client() is not None


def _call(prompt: str, max_tokens: int = 200, image_b64: str | None = None) -> str | None:
    """Single Claude API call. Returns text or None on failure."""
    client = _get_client()
    if not client:
        return None
    try:
        if image_b64:
            content = [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": image_b64,
                    },
                },
                {"type": "text", "text": prompt},
            ]
        else:
            content = prompt

        resp = client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": content}],
        )
        return resp.content[0].text.strip()
    except Exception as e:
        logger.warning(f"[AIBrain] API call failed: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# 1. COMMENT GENERATION
# ─────────────────────────────────────────────────────────────────────────────

def generate_comment(
    video_title: str,
    channel_name: str = "",
    fallback_templates: list[str] | None = None,
    rng: random.Random | None = None,
) -> str:
    context = f'Video: "{video_title}"'
    if channel_name:
        context += f' by {channel_name}'

    prompt = (
        f"{context}\n\n"
        "Write ONE short YouTube comment for this video. Rules:\n"
        "- 1-2 sentences max\n"
        "- Sound like a real viewer, not a bot\n"
        "- Relate naturally to the video topic\n"
        "- No hashtags, no emojis\n"
        "- Casual, genuine tone\n"
        "Output ONLY the comment text, nothing else."
    )
    result = _call(prompt, max_tokens=80)
    if result:
        comment = result.strip('"').strip("'")
        if comment and len(comment) > 5:
            logger.info(f"[AIBrain] AI comment: {comment[:60]!r}")
            return comment

    if fallback_templates:
        _rng = rng or random.Random()
        return _rng.choice(fallback_templates)
    return "Great video, very informative!"


# ─────────────────────────────────────────────────────────────────────────────
# 2. KEYWORD SELECTION
# ─────────────────────────────────────────────────────────────────────────────

def pick_best_search_keyword(
    video_title: str,
    video_id: str = "",
    channel_name: str = "",
    fallback_keywords: list[str] | None = None,
    rng: random.Random | None = None,
) -> str:
    context = f'Video title: "{video_title}"'
    if channel_name:
        context += f', Channel: "{channel_name}"'

    prompt = (
        f"{context}\n\n"
        "What would a real YouTube user type in the search bar to find this video?\n"
        "Rules:\n"
        "- 2-5 words only\n"
        "- Natural search query, not the exact title\n"
        "- Think like someone who wants to learn about this topic\n"
        "Output ONLY the search query, nothing else."
    )
    result = _call(prompt, max_tokens=30)
    if result and len(result) > 3:
        logger.info(f"[AIBrain] AI keyword: {result!r}")
        return result.strip('"').strip("'")

    if fallback_keywords:
        _rng = rng or random.Random()
        return _rng.choice(fallback_keywords)
    return video_title


# ─────────────────────────────────────────────────────────────────────────────
# 3. AI DOM PAGE SCANNER
# ─────────────────────────────────────────────────────────────────────────────

def scan_page_for_element(
    dom_summary: str,
    element_description: str,
    screenshot_b64: str | None = None,
) -> dict:
    """
    Given a page DOM summary or screenshot, ask Claude where the element is.
    Returns: {found, css_selector, text_to_click, explanation}
    """
    if screenshot_b64:
        prompt = (
            f"I am on a YouTube page. I need to find: **{element_description}**\n\n"
            "Look at this screenshot of the page.\n"
            "Tell me:\n"
            "1. Is this element visible? (yes/no)\n"
            "2. Best CSS selector to click it?\n"
            "3. Visible button text?\n\n"
            "Reply as JSON only:\n"
            '{"found": true/false, "css_selector": "...", "text_to_click": "...", "explanation": "..."}'
        )
    else:
        prompt = (
            f"I am on a YouTube page. I need to find: **{element_description}**\n\n"
            f"Page DOM summary:\n{dom_summary[:3000]}\n\n"
            "Based on the DOM above, tell me:\n"
            "1. Is this element visible on the page? (yes/no)\n"
            "2. What is the best CSS selector to click it?\n"
            "3. What visible text does it have?\n\n"
            "Reply as JSON only:\n"
            '{"found": true/false, "css_selector": "...", "text_to_click": "...", "explanation": "..."}'
        )

    result = _call(prompt, max_tokens=150, image_b64=screenshot_b64)
    if result:
        try:
            json_match = re.search(r'\{.*\}', result, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group())
                logger.info(f"[AIBrain] Page scan for '{element_description}': found={data.get('found')}")
                return data
        except Exception:
            pass

    return {"found": False, "css_selector": None, "text_to_click": None, "explanation": result or "AI scan failed"}


# ─────────────────────────────────────────────────────────────────────────────
# 4. AI VIDEO IDENTIFIER
# ─────────────────────────────────────────────────────────────────────────────

def identify_target_video(
    results: list[dict],
    target_video_id: str,
    target_title: str = "",
    target_channel: str = "",
) -> int | None:
    """
    Given search result cards, return the INDEX of best matching video.
    Returns None if not found.
    """
    if not results:
        return None

    # First: exact video_id match (no AI needed)
    for i, r in enumerate(results):
        href = r.get("href", "")
        if target_video_id and target_video_id in href:
            logger.info(f"[AIBrain] Exact video_id match at index {i}")
            return i

    # AI fuzzy match
    results_text = "\n".join(
        f"[{i}] title={r.get('title','')!r} channel={r.get('channel','')!r} url={r.get('href','')[:60]}"
        for i, r in enumerate(results[:15])
    )

    prompt = (
        f"I am looking for a YouTube video:\n"
        f"  Target title: {target_title!r}\n"
        f"  Target channel: {target_channel or 'unknown'!r}\n"
        f"  Target video_id: {target_video_id!r}\n\n"
        f"Search results:\n{results_text}\n\n"
        "Which result index (0-based) is the best match for the target video?\n"
        "If none match, reply -1.\n"
        'Reply as JSON only: {"index": <number>, "reason": "..."}'
    )

    result = _call(prompt, max_tokens=80)
    if result:
        try:
            json_match = re.search(r'\{.*\}', result, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group())
                idx = int(data.get("index", -1))
                if 0 <= idx < len(results):
                    logger.info(f"[AIBrain] AI video match: index={idx} reason={data.get('reason','')!r}")
                    return idx
        except Exception:
            pass

    return None


# ─────────────────────────────────────────────────────────────────────────────
# 5. AI ENGAGEMENT VERIFIER
# ─────────────────────────────────────────────────────────────────────────────

def verify_engagement(
    dom_summary: str,
    action: str,
    screenshot_b64: str | None = None,
) -> dict:
    """
    Verify that an engagement action was successfully performed.
    action: 'like' | 'subscribe' | 'autoplay_off' | 'quality_360p' | 'bell' | 'comment_posted'
    Returns: {confirmed, state, suggestion}
    """
    action_descriptions = {
        "like": "the Like button is pressed/active (aria-pressed=true or blue/highlighted)",
        "subscribe": "the Subscribe button shows 'Subscribed' state",
        "autoplay_off": "the Autoplay toggle is OFF (not enabled, aria-checked=false)",
        "quality_360p": "the video quality is set to 360p",
        "bell": "the notification bell is active/subscribed",
        "comment_posted": "a comment was successfully posted",
        "dislike": "the Dislike button is pressed/active",
    }
    description = action_descriptions.get(action, action)

    if screenshot_b64:
        prompt = (
            f"Look at this YouTube page screenshot.\n"
            f"Verify: {description}\n\n"
            "Reply as JSON only:\n"
            '{"confirmed": true/false, "state": "what you see", "suggestion": "what to do if not confirmed"}'
        )
        result = _call(prompt, max_tokens=120, image_b64=screenshot_b64)
    else:
        prompt = (
            f"YouTube page DOM summary:\n{dom_summary[:2000]}\n\n"
            f"Verify: {description}\n\n"
            "Reply as JSON only:\n"
            '{"confirmed": true/false, "state": "what you see", "suggestion": "what to do if not confirmed"}'
        )
        result = _call(prompt, max_tokens=120)

    if result:
        try:
            json_match = re.search(r'\{.*\}', result, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group())
                logger.info(f"[AIBrain] Verify '{action}': confirmed={data.get('confirmed')}")
                return data
        except Exception:
            pass

    return {"confirmed": False, "state": "unknown", "suggestion": f"retry {action}"}


# ─────────────────────────────────────────────────────────────────────────────
# 6. AI ERROR RECOVERY
# ─────────────────────────────────────────────────────────────────────────────

def recover_from_error(
    error_message: str,
    dom_summary: str,
    current_url: str,
    goal: str,
    screenshot_b64: str | None = None,
) -> dict:
    """
    When something fails, ask Claude what to do next.
    Returns: {action, target, explanation}
    """
    if screenshot_b64:
        prompt = (
            f"YouTube automation error recovery.\n"
            f"Current URL: {current_url}\n"
            f"Goal: {goal}\n"
            f"Error: {error_message}\n\n"
            "Look at the screenshot. What should I do to recover?\n"
            "Reply as JSON only:\n"
            '{"action": "click|navigate|search|wait|skip", "target": "...", "explanation": "..."}'
        )
        result = _call(prompt, max_tokens=150, image_b64=screenshot_b64)
    else:
        prompt = (
            f"YouTube automation error recovery.\n"
            f"Current URL: {current_url}\n"
            f"Goal: {goal}\n"
            f"Error: {error_message}\n\n"
            f"Page DOM summary:\n{dom_summary[:2000]}\n\n"
            "What should I do to recover?\n"
            "Reply as JSON only:\n"
            '{"action": "click|navigate|search|wait|skip", "target": "...", "explanation": "..."}'
        )
        result = _call(prompt, max_tokens=150)

    if result:
        try:
            json_match = re.search(r'\{.*\}', result, re.DOTALL)
            if json_match:
                data = json.loads(json_match.group())
                logger.info(f"[AIBrain] Recovery: action={data.get('action')!r}")
                return data
        except Exception:
            pass

    return {"action": "skip", "target": "", "explanation": "AI recovery failed — skipping"}


# ─────────────────────────────────────────────────────────────────────────────
# 7. PER-PERSONA KEYWORD PICKER (Smart Legacy Search)
# ─────────────────────────────────────────────────────────────────────────────

def pick_keyword_for_persona(
    video_title: str,
    channel_name: str,
    viewer_persona: str,
    profile_seed: int,
    fallback_keywords: list[str] | None = None,
    rng: random.Random | None = None,
) -> str:
    """
    Generate a unique natural search keyword for a specific viewer persona.

    viewer_persona : e.g. "curious student", "working professional" (from VIEWER_PERSONAS)
    profile_seed   : deterministic int derived from profile_id SHA-256
    fallback_keywords : used when AI unavailable

    Returns a search query string (2-5 words), unique to this persona + profile seed.
    """
    context = f'Video: "{video_title}"'
    if channel_name:
        context += f', Channel: "{channel_name}"'

    # Include seed in prompt so same video + different persona → different keywords
    prompt = (
        f"{context}\n"
        f"Viewer type: {viewer_persona!r}\n"
        f"Profile seed: {profile_seed % 997}\n\n"
        "What would THIS specific viewer type in YouTube search to find this video?\n"
        "Rules:\n"
        "- 2-5 words only\n"
        "- Natural phrasing for this viewer type (e.g. student searches differently than professional)\n"
        "- Do NOT use the exact video title\n"
        "- Be unique — think from this persona's perspective\n"
        "Output ONLY the search query text, nothing else."
    )

    result = _call(prompt, max_tokens=30)
    if result and len(result.strip()) > 3:
        keyword = result.strip().strip('"').strip("'")
        # Sanity: reject if same as title
        if keyword.lower() != video_title.lower() and len(keyword) > 3:
            logger.info(
                f"[AIBrain] Persona keyword [{viewer_persona!r}]: {keyword!r}"
            )
            return keyword

    # AI unavailable or bad response — pick from fallback pool
    if fallback_keywords:
        _rng = rng or random.Random(profile_seed)
        # Shuffle fallback list with profile seed so order is per-profile unique
        shuffled = list(fallback_keywords)
        _rng.shuffle(shuffled)
        return shuffled[0]

    # Last resort: use first 3-4 words of title
    words = video_title.split()
    return " ".join(words[:4]) if len(words) >= 4 else video_title


# ─────────────────────────────────────────────────────────────────────────────
# 8. WATCH BEHAVIOR PATTERN
# ─────────────────────────────────────────────────────────────────────────────

def get_natural_watch_pattern(
    video_duration: float,
    planned_watch: float,
    personality: str = "normal",
) -> dict:
    """Natural watch behavior from Claude — pause probability, seek, scroll breaks."""
    defaults = {
        "pause_probability": 0.12,
        "seek_probability": 0.18,
        "scroll_breaks": 1,
        "engagement_delay_factor": 1.0,
    }
    prompt = (
        f"A YouTube viewer ('{personality}' personality) watching a "
        f"{video_duration:.0f}s video, plans to watch {planned_watch:.0f}s.\n\n"
        "Give natural viewing behavior as JSON:\n"
        '{"pause_probability": 0.0-0.25, "seek_probability": 0.0-0.25, '
        '"scroll_breaks": 0-3, "engagement_delay_factor": 0.8-1.3}\n'
        "Output ONLY valid JSON."
    )
    result = _call(prompt, max_tokens=80)
    if result:
        try:
            json_match = re.search(r'\{.*\}', result, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                for k in defaults:
                    if k in parsed:
                        defaults[k] = parsed[k]
                logger.info(f"[AIBrain] Watch pattern: {defaults}")
        except Exception:
            pass
    return defaults
