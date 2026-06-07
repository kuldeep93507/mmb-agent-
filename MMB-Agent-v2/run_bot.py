"""
MMB Bot Entry Point
===================
Dashboard ke "Start Bot" button se yeh file launch hoti hai.

Usage (manual):
    python run_bot.py

Usage (dashboard):
    Dashboard → Control tab → ▶ Start Bot
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)

logger = logging.getLogger("mmb.run_bot")


async def main() -> None:
    logger.info("MMB Bot starting...")

    # ── Import Orchestrator ───────────────────────────────────────────────────
    try:
        from core.Orchestrator import Orchestrator
    except ImportError as e:
        logger.error("Orchestrator import failed: %s", e)
        sys.exit(1)

    # ── Load config ───────────────────────────────────────────────────────────
    config_path = ROOT / "config" / "settings.json"
    if not config_path.exists():
        logger.warning("config/settings.json not found — using defaults")
        config = {}
    else:
        import json
        config = json.loads(config_path.read_text(encoding="utf-8"))

    # ── Run Orchestrator ──────────────────────────────────────────────────────
    try:
        orc = Orchestrator(config)
        logger.info("Orchestrator initialized ✓")
        await orc.run()
    except KeyboardInterrupt:
        logger.info("Bot stopped by user (Ctrl+C)")
    except Exception as e:
        logger.exception("Bot crashed: %s", e)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
