"""
Shared types for YouTube automation — MMB AGENT 24/7
Adapted from MMB-Agent-v2/behavior/youtube/types.py
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = PROJECT_ROOT / "logs"
FAIL_SCREENSHOT_DIR = LOG_DIR / "human_failures"
SELECTOR_FAILURE_LOG = LOG_DIR / "selector_failures.json"


class PlatformKind(str, Enum):
    DESKTOP = "desktop"
    MOBILE = "mobile"


class YouTubeManagerError(Exception):
    """Raised when YouTube automation fails irrecoverably."""


class ElementNotFoundError(YouTubeManagerError):
    """Raised when a DOM target is missing — retry-with-scroll, do not tear down browser."""


@dataclass
class VideoTarget:
    """Describes the video the session should reach organically."""
    video_id: Optional[str] = None
    search_keywords: Optional[str] = None
    title_hint: Optional[str] = None
    channel_name: Optional[str] = None
    direct_url: Optional[str] = None

    def validate(self) -> None:
        if self.direct_url:
            return
        if not self.video_id and not self.search_keywords:
            raise YouTubeManagerError(
                "Provide video_id or search_keywords for organic navigation."
            )


class WatchTimeMode(str, Enum):
    SHORT  = "short"
    MEDIUM = "medium"
    LONG   = "long"
    SMART  = "smart"
    FIXED  = "fixed"


@dataclass
class WatchTimeConfig:
    mode: str = WatchTimeMode.MEDIUM
    min_seconds: float = 90.0
    max_seconds: float = 180.0
    smart_min_pct: float = 0.40
    smart_max_pct: float = 0.60
    fixed_seconds: float = 120.0

    def __post_init__(self) -> None:
        try:
            self.mode = WatchTimeMode(self.mode.lower().strip()).value
        except ValueError:
            self.mode = WatchTimeMode.MEDIUM.value
        self.min_seconds = max(30.0, float(self.min_seconds))
        self.max_seconds = max(self.min_seconds + 10.0, float(self.max_seconds))
        self.smart_min_pct = max(0.20, min(0.95, float(self.smart_min_pct)))
        self.smart_max_pct = max(self.smart_min_pct + 0.05, min(1.0, float(self.smart_max_pct)))
        self.fixed_seconds = max(30.0, float(self.fixed_seconds))

    def resolve(self, video_duration_seconds: Optional[float], rng: Optional[Any] = None) -> float:
        _rng = rng or random.Random()
        dur = float(video_duration_seconds or 0.0)
        if self.mode == WatchTimeMode.FIXED:
            return self.fixed_seconds
        if self.mode == WatchTimeMode.SHORT:
            return _rng.uniform(60.0, 90.0)
        if self.mode == WatchTimeMode.MEDIUM:
            return _rng.uniform(120.0, 180.0)
        if self.mode == WatchTimeMode.LONG:
            return _rng.uniform(180.0, 300.0)
        if self.mode == WatchTimeMode.SMART:
            if dur > 30.0:
                pct = _rng.uniform(self.smart_min_pct, self.smart_max_pct)
                raw = dur * pct
                return max(60.0, min(raw, dur - 5.0))
            return _rng.uniform(120.0, 180.0)
        return _rng.uniform(120.0, 180.0)

    @classmethod
    def from_dict(cls, data: dict) -> "WatchTimeConfig":
        if not isinstance(data, dict):
            return cls()
        return cls(
            mode=str(data.get("mode", WatchTimeMode.MEDIUM)),
            min_seconds=float(data.get("min_seconds", 90.0)),
            max_seconds=float(data.get("max_seconds", 180.0)),
            smart_min_pct=float(data.get("smart_min_pct", 0.40)),
            smart_max_pct=float(data.get("smart_max_pct", 0.60)),
            fixed_seconds=float(data.get("fixed_seconds", 120.0)),
        )

    @classmethod
    def default(cls) -> "WatchTimeConfig":
        return cls(mode=WatchTimeMode.MEDIUM)


@dataclass
class EngagementAction:
    enabled: bool = False
    probability: float = 1.0
    must_do: bool = False

    def should_attempt(self, rng: Any) -> bool:
        if not self.enabled:
            return False
        if self.must_do:
            return True
        return rng.random() < self.probability

    @classmethod
    def from_dict(cls, data: Any, default_enabled: bool = False) -> "EngagementAction":
        if isinstance(data, bool):
            return cls(enabled=data, probability=1.0, must_do=data)
        if isinstance(data, dict):
            return cls(
                enabled=bool(data.get("enabled", default_enabled)),
                probability=float(data.get("probability", 1.0)),
                must_do=bool(data.get("must_do", False)),
            )
        return cls(enabled=default_enabled)


@dataclass
class EngagementConfig:
    like: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  probability=0.80))
    dislike: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=False))
    subscribe: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  probability=0.30))
    bell: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  probability=0.50))
    comment: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  probability=0.40))
    autoplay_off: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  must_do=True))
    ads_skip: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  must_do=True))
    quality_enabled: bool = True
    quality_target: str = "360p"
    ads_skip_after_seconds: int = 5
    comment_templates: List[str] = field(default_factory=list)

    def pick_comment(
        self,
        rng: Any,
        fallback: Optional[str] = None,
        video_title: str = "",
        channel_name: str = "",
        use_ai: bool = True,
    ) -> Optional[str]:
        pool = [t for t in self.comment_templates if t and t.strip()]
        if use_ai and video_title:
            try:
                from server_python.ai_brain import generate_comment, is_available
                if is_available():
                    return generate_comment(
                        video_title=video_title,
                        channel_name=channel_name,
                        fallback_templates=pool or None,
                        rng=rng,
                    )
            except Exception:
                pass
        if pool:
            return rng.choice(pool)
        return fallback

    @classmethod
    def from_dict(cls, data: dict) -> "EngagementConfig":
        if not isinstance(data, dict):
            return cls()
        quality_raw = data.get("quality", {})
        quality_enabled, quality_target = True, "360p"
        if isinstance(quality_raw, bool):
            quality_enabled = quality_raw
        elif isinstance(quality_raw, dict):
            quality_enabled = bool(quality_raw.get("enabled", True))
            quality_target = str(quality_raw.get("target", "360p"))
        elif isinstance(quality_raw, str):
            quality_target = quality_raw

        ads_raw = data.get("ads_skip", {"enabled": True, "must_do": True})
        ads_action = EngagementAction.from_dict(ads_raw, default_enabled=True)
        ads_skip_after = int(ads_raw.get("skip_after_seconds", 5)) if isinstance(ads_raw, dict) else 5

        templates_raw = data.get("comment_templates", [])
        templates = [str(t).strip() for t in templates_raw if str(t).strip()] if isinstance(templates_raw, list) else []

        return cls(
            like=EngagementAction.from_dict(data.get("like", {"enabled": True, "probability": 0.80}), True),
            dislike=EngagementAction.from_dict(data.get("dislike", {"enabled": False}), False),
            subscribe=EngagementAction.from_dict(data.get("subscribe", {"enabled": True, "probability": 0.30}), True),
            bell=EngagementAction.from_dict(data.get("bell", {"enabled": True, "probability": 0.50}), True),
            comment=EngagementAction.from_dict(data.get("comment", {"enabled": True, "probability": 0.40}), True),
            autoplay_off=EngagementAction.from_dict(data.get("autoplay_off", {"enabled": True, "must_do": True}), True),
            ads_skip=ads_action,
            quality_enabled=quality_enabled,
            quality_target=quality_target,
            ads_skip_after_seconds=ads_skip_after,
            comment_templates=templates,
        )

    @classmethod
    def default(cls) -> "EngagementConfig":
        return cls()
