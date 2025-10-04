# link.py — load templates from file + MQTT bridge
from pathlib import Path
import os
from omnilink import (
    TypeRegistry,
    OmniLinkEngine,
    OmniLinkMQTTBridge,
    load_patterns_from_file,
    give_context,
    start_periodic_context,
)
from chess_api import move_piece, get_context, register_move_listener

# --- Load templates from chess_commands_omnilink.txt ---
HERE = Path(__file__).resolve().parent
PATTERNS_FILE = HERE / "chess_commands_omnilink.txt"

types = TypeRegistry()
TEMPLATES = load_patterns_from_file(PATTERNS_FILE, types)
engine = OmniLinkEngine(TEMPLATES, types=types)


def _send_full_context(*_args):
    give_context(get_context(full=True))


register_move_listener(_send_full_context)


# --- Catch-all handler (prints captured vars) ---
def handle_any(evt):
    print("[link] EVENT matched -> template:", evt["template"], "vars:", evt["vars"])
    v = evt.get("vars", {})
    try:
        color      = v["color"]
        piece      = v["piece"]
        location1  = v["location1"]
        location2  = v["location2"]

        move_piece(color, piece, location1, location2)
    except KeyError as e:
        return {"ack": False}
    
    
    return {"ack": True}

engine.on(lambda e: True, handle_any)

# --- MQTT bridge ---
bridge = OmniLinkMQTTBridge(engine)

#start_periodic_context(30, lambda: get_context(full=True))  # send context every 30 sec

bridge.loop_forever()                           
