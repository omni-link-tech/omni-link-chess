#!/usr/bin/env python3
"""Remote polling bridge that drives chess moves via OmniLink."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from chess_api import get_context, move_piece, register_move_listener
from omnilink import (
    OmniLinkEngine,
    OmniLinkRemoteCommandBridge,
    TypeRegistry,
    give_context,
    load_patterns_from_file,
    start_periodic_context,
)

HERE = Path(__file__).resolve().parent
PATTERNS_FILE = HERE / "chess_commands_omnilink.txt"

types = TypeRegistry()
templates = load_patterns_from_file(PATTERNS_FILE, types)
engine = OmniLinkEngine(templates, types=types)


def _send_full_context(*_args: Any) -> None:
    """Push the latest chess board context to OmniLink."""

    give_context(get_context(full=True))


register_move_listener(_send_full_context)


def _handle_any(event: Dict[str, Any]) -> Dict[str, Any]:
    """Execute any recognised command and report acknowledgement."""

    vars_ = event.get("vars", {})

    try:
        color = vars_["color"]
        piece = vars_["piece"]
        location1 = vars_["location1"]
        location2 = vars_["location2"]
    except KeyError:
        return {"ack": False}

    move_piece(color, piece, location1, location2)
    return {"ack": True}


engine.on(lambda _event: True, _handle_any)


def main() -> None:
    """Start polling Supabase for remote commands."""

    give_context(get_context(full=True))
    start_periodic_context(30, lambda: get_context(full=True))

    bridge = OmniLinkRemoteCommandBridge(engine)
    bridge.loop_forever()


if __name__ == "__main__":
    main()
