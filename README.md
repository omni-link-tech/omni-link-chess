# Omni Link Demo

This repository hosts a simple Omni Link demo that connects the 3D chess
visualisation with a lightweight Python controller. The instructions below walk
through setting up the JavaScript + Python stack from scratch and explain how
the Python helper modules fit together.

## Omni Link Agent setup

Main Task: 
`You are a chess coach. You help users learn chess. You can play games with the users.`

Available Commands:  
`move_[color]_[piece]_from_[location1]_to_[location2],`

Custom Instructions:
`Commands are like: move_white_knight_from_a2_to_a3 
You can execute move pieces using commands when playing with the users.`

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (the demo uses Vite and a small
  Node.js WebSocket/HTTP server).
- `npm` (bundled with Node.js) for installing dependencies and running scripts.
- Python 3.9+ with `pip` for the link bridge and helper API.

## Run the demo end-to-end

1. **Clone the repository and enter it**

   ```bash
   git clone <this-repo-url>
   cd omni-link-chess
   ```

2. **Install the JavaScript dependencies**

   ```bash
   npm install
   ```

3. **(Optional) Create and activate a Python virtual environment**

   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```

4. **Install the Python dependencies**

   ```bash
   pip install requests paho-mqtt
   ```

   `requests` powers the HTTP helper used to talk to the chess server, while
   `paho-mqtt` lets the bridge publish and receive MQTT messages.

5. **Start the JavaScript experience**

   ```bash
   npm run demo
   ```

   The `demo` script runs two processes via `concurrently`:

   - `npm run dev` starts the Vite development server that serves the React 3D
     chess front end (defaults to `http://localhost:5173`).
   - `npm run server` launches `server.js`, an Express + WebSocket process on
     `http://localhost:8765` that maintains chess state and receives commands.

   Leave this command running.

6. **Launch the Python Omni Link bridge** in a second terminal (with the same
   virtual environment if you created one):

   ```bash
   python chess_link/link.py
   ```

   By default the bridge connects to an MQTT broker over WebSockets at
   `ws://localhost:9001`, subscribing to `olink/commands` and publishing
   feedback to `olink/commands_feedback`. You can override the broker host,
   port, transport, and topic names with the environment variables described in
   `chess_link/omnilink.py` (for example `MQTT_HOST`, `MQTT_PORT`, or
   `MQTT_COMMAND_TOPIC`).

7. **Open the front end** at `http://localhost:5173` to view the 3D board. You
   can now drive moves via MQTT voice/command templates or directly from
   Python using the helper API below.

## Python chess API (`chess_link/chess_api.py`)

Import the helper once the JavaScript and Python processes above are running:

```python
from chess_link.chess_api import move_piece, get_context, register_move_listener
```

The module targets the Node server at `http://localhost:8765` and provides the
following functions:

- **`move_piece(color, piece, from_square, to_square)`** — validates that the
  colour and piece name are recognised, then POSTs a command such as
  `move_white_pawn_from_e2_to_e4` to the chess server. This is the primary way
  to drive piece motion programmatically.
- **`get_context(full: bool = False)`** — issues `GET /context` to retrieve the
  server's board summary. With `full=False` (default) you receive the latest
  context string shared with the UI. With `full=True` the helper expands the
  payload into a human-readable list of every piece and its location, omitting
  noisy telemetry fields like the last move string.
- **`register_move_listener(listener)`** — installs a callback that runs after
  each successful `move_piece` call. Listeners receive the colour, piece type,
  and origin/destination squares so you can mirror moves or trigger additional
  logic when the Python side moves a piece.

Behind the scenes the module keeps small helper utilities for formatting context
information (for example, converting the JSON board representation into natural
language) so your integrations can display a readable snapshot of the board.

## Omni Link bridge (`chess_link/link.py`)

The bridge script glues the speech/command layer to the chess engine:

1. **Template compilation** — it loads the command patterns from
   `chess_commands_omnilink.txt` into an `OmniLinkEngine` using the shared `TypeRegistry`
   from `omnilink.py`. These templates describe natural-language or structured MQTT
   commands such as `move [color] [piece] from [location1] to [location2]`.
2. **Automatic context updates** — a listener registered via
   `register_move_listener` calls `give_context(get_context(full=True))` after
   every move so the MQTT side always receives a fresh description of the board
   on the `olink/context` topic.
3. **Catch-all move handler** — the `handle_any` function receives every parsed
   event, logs the template match, extracts the colour, piece, and origin/dest
   squares, and delegates to `move_piece`. If the command is missing required
   fields it responds with `{"ack": False}` so the MQTT client knows the move
   failed; otherwise it returns `{"ack": True}`.
4. **MQTT bridge** — `OmniLinkMQTTBridge(engine).loop_forever()` establishes a
   connection to the broker (defaulting to WebSockets on localhost:9001) and
   continually processes commands. You can customise the broker and topics via
   the environment variables handled by `OmniLinkMQTTBridge` (for example
   `MQTT_TRANSPORT=classic` to use TCP instead of WebSockets).

Run `python chess_link/link.py` alongside the JavaScript stack to tie everything
into the 3D board experience.
