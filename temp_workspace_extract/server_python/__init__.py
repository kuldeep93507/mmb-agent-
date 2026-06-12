"""
server_python — MMB AGENT 24/7 Python Backend Package

This __init__.py makes server_python a proper Python package so that
all internal imports like:
    from server_python.agent_manager import YouTubeAgent
    from server_python.behavior.youtube import desktop as yt_desktop
work correctly regardless of working directory.

NOTE: No heavy imports here — keep this file lightweight.
      Heavy modules are imported on-demand in their respective files.
"""
from __future__ import annotations

# Package version
__version__ = "2.0.0"
__author__  = "MMB Agent"
