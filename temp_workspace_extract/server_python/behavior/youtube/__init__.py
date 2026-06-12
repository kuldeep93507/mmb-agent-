"""
behavior.youtube package — YouTube automation modules.

FIXED:
  ✅ All submodules now properly exported so callers can do:
       from server_python.behavior.youtube import desktop as yt_desktop
       from server_python.behavior.youtube import state, quality, entry_flow
     instead of needing full dotted path every time.
"""
from server_python.behavior.youtube import desktop          # noqa: F401
from server_python.behavior.youtube import entry_flow       # noqa: F401
from server_python.behavior.youtube import state            # noqa: F401
from server_python.behavior.youtube import quality          # noqa: F401
from server_python.behavior.youtube import scroll_activity  # noqa: F401
from server_python.behavior.youtube import player_focus     # noqa: F401
from server_python.behavior.youtube import player_controls  # noqa: F401
from server_python.behavior.youtube import safe_actions     # noqa: F401
from server_python.behavior.youtube import verify_actions   # noqa: F401
from server_python.behavior.youtube import action_audit     # noqa: F401
from server_python.behavior.youtube import action_context   # noqa: F401
from server_python.behavior.youtube import selectors        # noqa: F401
from server_python.behavior.youtube import play_pause_limiter  # noqa: F401
