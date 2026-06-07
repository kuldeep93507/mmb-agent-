"""Shared types, constants, and dataclasses for YouTube automation."""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional, List

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_ENV_PATH = PROJECT_ROOT / ".env"
DEFAULT_LOG_PATH = PROJECT_ROOT / "logs" / "youtube_universal.log"
SELECTOR_FAILURE_LOG = PROJECT_ROOT / "logs" / "youtube_selector_failures.json"

YOUTUBE_HOME_DESKTOP = "https://www.youtube.com"
YOUTUBE_HOME_MOBILE = "https://m.youtube.com"

TRAFFIC_MIX: tuple[tuple[str, float], ...] = (
    ("search", 0.60),
    ("homepage", 0.20),
    ("suggested", 0.20),
)

PLAYBACK_SPEEDS: tuple[float, ...] = (1.0, 1.0, 1.0, 1.25, 1.25)


class PlatformKind(str, Enum):
    DESKTOP = "desktop"
    MOBILE = "mobile"


class NavigationRoute(str, Enum):
    SEARCH = "search"
    HOMEPAGE = "homepage"
    SUGGESTED = "suggested"
    DIRECT = "direct"


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


@dataclass
class WatchSessionResult:
    """Summary of a completed watch session."""

    platform: str
    route: str
    video_id: Optional[str]
    planned_watch_seconds: float
    actual_watch_seconds: float
    watch_fraction: float
    liked: bool = False
    subscribed: bool = False
    commented: bool = False
    engagement_events: list[str] = field(default_factory=list)


class EntryPath(str, Enum):
    SEARCH = "search"
    NOTIFICATION = "notification"
    HOMEPAGE = "homepage"


class AdStrategy(str, Enum):
    SKIP_ALL = "skip_all"
    CLICK_END_AD = "click_end_ad"
    WATCH_ALL = "watch_all"


class EngagementIntensity(str, Enum):
    LOW = "low"       # 1-2 random interactions
    MEDIUM = "medium" # 3-4 random interactions
    HIGH = "high"     # 5+ all interactions enabled


@dataclass
class ProfileConfig:
    """
    User-configurable per-profile behaviour.
    Pass this to YouTubeManager to fully control every session.

    Example::
        cfg = ProfileConfig(
            entry_path='notification',
            actions={'like': True, 'subscribe': True, 'comment': True, 'bell': True},
            ad_strategy='skip_all',
            watch_time_pct=0.85,
            engagement_intensity='high',
            own_channel_ids=['UCxxxxxx', 'UCyyyyyy'],
            comment_text='Great video!',
        )
        manager = YouTubeManager(profile_id=..., profile_config=cfg)
    """
    entry_path: str = "search"          # EntryPath value
    actions: dict[str, bool] = field(default_factory=lambda: {
        "like": True,
        "subscribe": True,
        "comment": False,
        "bell": True,
        "dislike": False,
    })
    ad_strategy: str = "skip_all"       # AdStrategy value
    watch_time_pct: float = 0.80        # 0.0 – 1.0
    engagement_intensity: str = "medium"  # EngagementIntensity value
    own_channel_ids: List[str] = field(default_factory=list)
    comment_text: Optional[str] = None

    def __post_init__(self) -> None:
        # Normalise & validate
        self.entry_path = self.entry_path.lower().strip()
        self.ad_strategy = self.ad_strategy.lower().strip()
        self.engagement_intensity = self.engagement_intensity.lower().strip()
        self.watch_time_pct = max(0.10, min(1.0, self.watch_time_pct))
        valid_paths = {e.value for e in EntryPath}
        if self.entry_path not in valid_paths:
            raise ValueError(f"entry_path must be one of {valid_paths}")
        valid_ad = {e.value for e in AdStrategy}
        if self.ad_strategy not in valid_ad:
            raise ValueError(f"ad_strategy must be one of {valid_ad}")
        valid_int = {e.value for e in EngagementIntensity}
        if self.engagement_intensity not in valid_int:
            raise ValueError(f"engagement_intensity must be one of {valid_int}")

    def action_enabled(self, key: str) -> bool:
        return bool(self.actions.get(key, False))

    @property
    def interaction_count(self) -> int:
        """How many extra micro-interactions to do based on intensity."""
        return {"low": 2, "medium": 4, "high": 7}.get(self.engagement_intensity, 4)


@dataclass
class InteractionContext:
    """Runtime dependencies injected into platform strategies."""

    identity: dict[str, Any]
    rng: Any
    logger: Any
    watch_mean: float
    platform: PlatformKind
    behavior_profile: str = "default"
    pause_probability: float = 0.10
    watch_chunk_min: float = 4.0
    watch_chunk_max: float = 18.0

    @property
    def is_mobile(self) -> bool:
        return self.platform == PlatformKind.MOBILE

    @property
    def youtube_home(self) -> str:
        return YOUTUBE_HOME_MOBILE if self.is_mobile else YOUTUBE_HOME_DESKTOP


# ---------------------------------------------------------------------------
# SPRINT 1: Watch Time + Engagement Full Config
# ---------------------------------------------------------------------------

class WatchTimeMode(str, Enum):
    """How long each session watches a video.

    short    → 60-90s    (safe minimum YouTube count)
    medium   → 120-180s  (recommended for most videos)
    long     → 180-300s  (best for longer videos)
    smart    → 40-60% of actual video duration (most realistic)
    fixed    → exact seconds from watch_time_seconds field
    """
    SHORT  = "short"
    MEDIUM = "medium"
    LONG   = "long"
    SMART  = "smart"   # % of video length
    FIXED  = "fixed"   # exact seconds


@dataclass
class WatchTimeConfig:
    """Per-job watch-time configuration.

    Loaded from jobs.json ``watch_time`` block.  Example::

        "watch_time": {
            "mode": "smart",
            "min_seconds": 90,
            "max_seconds": 300,
            "smart_min_pct": 0.40,
            "smart_max_pct": 0.60
        }

    ``resolve(video_duration_seconds)`` returns how many seconds to watch,
    taking mode into account.  Ads time is NOT counted — caller must subtract.
    """
    mode: str = WatchTimeMode.MEDIUM
    min_seconds: float = 90.0
    max_seconds: float = 180.0
    smart_min_pct: float = 0.40  # used only in SMART mode
    smart_max_pct: float = 0.60  # used only in SMART mode
    fixed_seconds: float = 120.0  # used only in FIXED mode

    def __post_init__(self) -> None:
        # Normalise mode string
        try:
            self.mode = WatchTimeMode(self.mode.lower().strip()).value
        except ValueError:
            self.mode = WatchTimeMode.MEDIUM.value

        # Sanity clamps
        self.min_seconds = max(30.0, float(self.min_seconds))
        self.max_seconds = max(self.min_seconds + 10.0, float(self.max_seconds))
        self.smart_min_pct = max(0.20, min(0.95, float(self.smart_min_pct)))
        self.smart_max_pct = max(self.smart_min_pct + 0.05, min(1.0, float(self.smart_max_pct)))
        self.fixed_seconds = max(30.0, float(self.fixed_seconds))

    def resolve(self, video_duration_seconds: Optional[float], rng: Optional[Any] = None) -> float:
        """Return how many seconds to actually watch.

        Falls back gracefully when video_duration unknown.
        """
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
                # Never less than 60s and never more than actual video length
                return max(60.0, min(raw, dur - 5.0))
            # Video duration unknown — fall back to medium
            return _rng.uniform(120.0, 180.0)

        # Unknown mode → medium
        return _rng.uniform(120.0, 180.0)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WatchTimeConfig":
        """Load from jobs.json ``watch_time`` block."""
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
        """Safe medium default — 120-180s."""
        return cls(mode=WatchTimeMode.MEDIUM)


@dataclass
class EngagementAction:
    """Config for one engagement action (like / subscribe / comment / etc.).

    ``enabled`` → agar False hai, kabhi bhi attempt nahi hoga (T1-04 fix).
    ``probability`` → agar enabled hai, yeh chance se attempt hoga (0.0 = never, 1.0 = always).
    ``must_do`` → True hone par probability ignore, hamesha attempt karo.
    """
    enabled: bool = False
    probability: float = 1.0   # 0.0–1.0
    must_do: bool = False       # override probability — hamesha karo

    def should_attempt(self, rng: Any) -> bool:
        """
        T1-04 rule:
          - enabled=False  → NEVER (no matter what)
          - enabled=True, must_do=True  → ALWAYS
          - enabled=True, must_do=False → roll probability
        """
        if not self.enabled:
            return False
        if self.must_do:
            return True
        return rng.random() < self.probability

    @classmethod
    def from_dict(cls, data: Any, default_enabled: bool = False) -> "EngagementAction":
        if isinstance(data, bool):
            # Simple true/false shorthand in jobs.json
            return cls(enabled=data, probability=1.0, must_do=data)
        if isinstance(data, dict):
            return cls(
                enabled=bool(data.get("enabled", default_enabled)),
                probability=float(data.get("probability", 1.0)),
                must_do=bool(data.get("must_do", False)),
            )
        return cls(enabled=default_enabled)


# ---------------------------------------------------------------------------
# SPRINT 2 T2-02: Related Video Config
# (Defined BEFORE EngagementConfig so it can be used as a field default)
# ---------------------------------------------------------------------------

@dataclass
class RelatedVideoConfig:
    """
    T2-02: Per-job related video config.
    Controls whether we click a related video from the sidebar after watching.

    Rule: ONLY own channel videos are ever clicked.
    Random related videos are NEVER clicked (own_channel_only is always True).

    Loaded from jobs.json engagement.related_video block::

        "related_video": {
            "enabled": true,
            "own_channel_only": true,
            "watch_seconds": 60,
            "probability": 0.50
        }

    own_video_ids and own_channel_ids are injected at runtime by Orchestrator
    (not parsed from jobs.json).
    """
    enabled: bool = False
    own_channel_only: bool = True      # hard rule — random click never allowed
    watch_pct_min: float = 0.90        # watch minimum 90% of video duration
    watch_pct_max: float = 1.00        # watch maximum 100% of video duration
    fallback_watch_seconds: float = 180.0  # fallback if duration unknown
    probability: float = 0.50             # per-session attempt probability

    # Runtime-injected by Orchestrator — not from jobs.json
    own_video_ids: set = field(default_factory=set)    # all job video_ids
    own_channel_ids: set = field(default_factory=set)  # all job channel_ids (UCxxxxx)

    def should_attempt(self, rng: Any) -> bool:
        """Return True if this session should attempt related video click."""
        if not self.enabled:
            return False
        return rng.random() < self.probability

    @classmethod
    def from_dict(cls, data: Any) -> "RelatedVideoConfig":
        """Parse from jobs.json engagement.related_video block."""
        if not isinstance(data, dict):
            return cls()
        _pct_min = max(0.50, min(1.0, float(data.get("watch_pct_min", 0.90))))
        _pct_max = max(0.50, min(1.0, float(data.get("watch_pct_max", 1.00))))
        # Ensure min <= max — swap if reversed (e.g. user sets min=0.95, max=0.80)
        if _pct_min > _pct_max:
            _pct_min, _pct_max = _pct_max, _pct_min
        return cls(
            enabled=bool(data.get("enabled", False)),
            own_channel_only=bool(data.get("own_channel_only", True)),
            watch_pct_min=_pct_min,
            watch_pct_max=_pct_max,
            fallback_watch_seconds=max(30.0, float(data.get("fallback_watch_seconds", 180.0))),
            probability=max(0.0, min(1.0, float(data.get("probability", 0.50)))),
            # own_video_ids / own_channel_ids NOT parsed — injected at runtime
        )

    @classmethod
    def default(cls) -> "RelatedVideoConfig":
        """Disabled by default — opt-in per job."""
        return cls(enabled=False)


@dataclass
class EngagementConfig:
    """Full per-job engagement settings.

    Loaded from jobs.json ``engagement`` block.  Example::

        "engagement": {
            "like":         {"enabled": true,  "probability": 0.80},
            "dislike":      {"enabled": false},
            "subscribe":    {"enabled": true,  "probability": 0.30},
            "bell":         {"enabled": true,  "probability": 0.50},
            "comment":      {"enabled": true,  "probability": 0.40},
            "autoplay_off": {"enabled": true,  "must_do": true},
            "ads_skip":     {"enabled": true,  "must_do": true,  "skip_after_seconds": 5},
            "quality":      {"enabled": true,  "target": "360p"},
            "description":  {"enabled": false}
        }

    T1-04 rule enforced here: enabled=True → attempt guaranteed (must_do=True default
    for critical actions like autoplay_off and ads_skip).
    """
    like: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  probability=0.80))
    dislike: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=False))
    subscribe: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  probability=0.30))
    bell: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  probability=0.50))
    comment: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  probability=0.40))
    autoplay_off: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  must_do=True))
    ads_skip: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=True,  must_do=True))
    description: EngagementAction = field(default_factory=lambda: EngagementAction(enabled=False))

    # Quality setting — special: not a simple bool
    quality_enabled: bool = True
    quality_target: str = "360p"   # "off" / "144p" / "240p" / "360p" / "480p" / "720p" / "1080p"

    # Ads skip timing
    ads_skip_after_seconds: int = 5

    # Comment templates pool — picked randomly each session
    comment_templates: List[str] = field(default_factory=list)

    # T2-02: Related video (own channel only) — disabled by default
    related_video: RelatedVideoConfig = field(default_factory=RelatedVideoConfig)

    def pick_comment(
        self,
        rng: Any,
        fallback: Optional[str] = None,
        video_title: str = "",
        channel_name: str = "",
        use_ai: bool = True,
    ) -> Optional[str]:
        """
        Pick a comment — tries AI generation first (if use_ai=True and API available),
        then falls back to template pool, then to fallback string.
        """
        pool = [t for t in self.comment_templates if t and t.strip()]
        if use_ai and video_title:
            try:
                from behavior.youtube.ai_brain import generate_comment, is_available
                if is_available():
                    return generate_comment(
                        video_title=video_title,
                        channel_name=channel_name,
                        fallback_templates=pool or None,
                        rng=rng,
                    )
            except Exception:
                pass  # silently fall through to template pool
        if pool:
            return rng.choice(pool)
        return fallback

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EngagementConfig":
        if not isinstance(data, dict):
            return cls()

        quality_raw = data.get("quality", {})
        quality_enabled = True
        quality_target = "360p"
        if isinstance(quality_raw, bool):
            quality_enabled = quality_raw
        elif isinstance(quality_raw, dict):
            quality_enabled = bool(quality_raw.get("enabled", True))
            quality_target = str(quality_raw.get("target", "360p"))
        elif isinstance(quality_raw, str):
            quality_target = quality_raw

        ads_raw = data.get("ads_skip", {"enabled": True, "must_do": True})
        ads_action = EngagementAction.from_dict(ads_raw, default_enabled=True)
        if isinstance(ads_raw, dict):
            ads_skip_after = int(ads_raw.get("skip_after_seconds", 5))
        else:
            ads_skip_after = 5

        # comment_templates can be at top-level OR inside "comment" block
        comment_raw = data.get("comment", {})
        comment_block_templates: List[str] = []
        if isinstance(comment_raw, dict):
            inner = comment_raw.get("comment_templates", [])
            if isinstance(inner, list):
                comment_block_templates = [str(t).strip() for t in inner if str(t).strip()]

        templates_raw = data.get("comment_templates", comment_block_templates)
        templates: List[str] = []
        if isinstance(templates_raw, list):
            templates = [str(t).strip() for t in templates_raw if str(t).strip()]
        # Merge both sources (top-level + inside comment block)
        if not templates:
            templates = comment_block_templates

        # T2-02: parse related_video block
        related_raw = data.get("related_video", None)
        related_cfg = RelatedVideoConfig.from_dict(related_raw) if related_raw else RelatedVideoConfig()

        return cls(
            like=EngagementAction.from_dict(data.get("like", {"enabled": True, "probability": 0.80}), True),
            dislike=EngagementAction.from_dict(data.get("dislike", {"enabled": False}), False),
            subscribe=EngagementAction.from_dict(data.get("subscribe", {"enabled": True, "probability": 0.30}), True),
            bell=EngagementAction.from_dict(data.get("bell", {"enabled": True, "probability": 0.50}), True),
            comment=EngagementAction.from_dict(data.get("comment", {"enabled": True, "probability": 0.40}), True),
            autoplay_off=EngagementAction.from_dict(data.get("autoplay_off", {"enabled": True, "must_do": True}), True),
            ads_skip=ads_action,
            description=EngagementAction.from_dict(data.get("description", {"enabled": False}), False),
            quality_enabled=quality_enabled,
            quality_target=quality_target,
            ads_skip_after_seconds=ads_skip_after,
            comment_templates=templates,
            related_video=related_cfg,
        )

    @classmethod
    def default(cls) -> "EngagementConfig":
        """Safe defaults — like ON, subscribe ON (low prob), comment ON (low prob)."""
        return cls()
