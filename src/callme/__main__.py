"""Entry point: python -m callme"""
from __future__ import annotations

import asyncio
import logging
import os
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    stream=sys.stderr,
)


def main() -> None:
    # Determine project root (where pyproject.toml lives)
    # Check --root argument or use the directory containing this package
    project_root = None
    for i, arg in enumerate(sys.argv):
        if arg == "--root" and i + 1 < len(sys.argv):
            project_root = sys.argv[i + 1]
            break

    if not project_root:
        # Default: parent of src/callme/ → project root
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    from .mcp_server import run_mcp_server
    asyncio.run(run_mcp_server(project_root))


if __name__ == "__main__":
    main()
