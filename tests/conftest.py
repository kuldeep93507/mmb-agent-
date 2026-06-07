"""Pytest path setup — behavior package lives under server_python/."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_PYTHON = ROOT / "server_python"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(SERVER_PYTHON) not in sys.path:
    sys.path.insert(0, str(SERVER_PYTHON))
