#!/usr/bin/env python3
"""TCP forwarding bridge for Omni Link chess commands."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from omnilink import (
    OmniLinkEngine,
    OmniLinkMQTTBridge,
    OmniLinkTCPAdapter,
    TypeRegistry,
    load_patterns_from_file,
)

HERE = Path(__file__).resolve().parent
PATTERNS_FILE = HERE / "chess_commands_omnilink.txt"


types = TypeRegistry()
TEMPLATES = load_patterns_from_file(PATTERNS_FILE, types)
engine = OmniLinkEngine(TEMPLATES, types=types)

tcp_adapter = OmniLinkTCPAdapter()


def handle_any(evt: Dict[str, Any]) -> Dict[str, Any]:
    """Forward every recognised command to the configured TCP endpoint."""

    command = evt.get("command")
    if not command:
        print("[link_tcp] Event did not contain a command payload")
        return {"ack": False}

    extra: Dict[str, Any] = {}
    if evt.get("text"):
        extra["text"] = evt["text"]
    if evt.get("timestamp") is not None:
        extra["timestamp"] = evt["timestamp"]

    try:
        tcp_adapter.send_command(
            command,
            vars=evt.get("vars") or None,
            template=evt.get("template"),
            meta=evt.get("meta") or None,
            extra=extra or None,
        )
    except Exception as exc:  # pragma: no cover - log and propagate ack failure
        print(f"[link_tcp] Failed to forward command: {exc}")
        return {"ack": False, "error": str(exc)}

    return {"ack": True}


def _always(_evt: Dict[str, Any]) -> bool:
    return True


engine.on(_always, handle_any)


if __name__ == "__main__":
    bridge = OmniLinkMQTTBridge(engine)
    bridge.loop_forever()
