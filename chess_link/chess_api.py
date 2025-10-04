"""Simple Python API to control the chess board via HTTP requests."""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List

import requests

SERVER_URL = "http://localhost:8765"

def _send(message: str) -> None:
    """Send ``message`` to the server via HTTP POST."""
    requests.post(SERVER_URL, json={"cmd": message}, timeout=5)

PIECES = {"pawn", "rook", "knight", "bishop", "queen", "king"}
COLORS = {"white", "black"}

_EXCLUDED_CONTEXT_KEYS = {
    "Last move",
    "Last command",
    "Last invalid command",
    "FEN",
}

_move_listeners: List[Callable[[str, str, str, str], None]] = []


def register_move_listener(listener: Callable[[str, str, str, str], None]) -> None:
    """Register ``listener`` to be called after each successful move.

    Parameters
    ----------
    listener: Callable[[str, str, str, str], None]
        A callback that receives ``color``, ``piece``, ``from_square`` and
        ``to_square`` describing the move that has just been issued.
    """

    if not callable(listener):
        raise TypeError("listener must be callable")

    _move_listeners.append(listener)

def move_piece(
    color: str,
    piece: str,
    from_square: str,
    to_square: str,
) -> None:
    """Move an arbitrary piece from one square to another.

    Parameters
    ----------
    color: str
        "white" or "black".
    piece: str
        One of ``pawn``, ``rook``, ``knight``, ``bishop``, ``queen`` or ``king``.
    from_square: str
        Source square in algebraic notation such as ``e2``.
    to_square: str
        Target square in algebraic notation such as ``e4``.
    """

    if color not in COLORS:
        raise ValueError(f"color must be one of {sorted(COLORS)}")
    if piece not in PIECES:
        raise ValueError(f"piece must be one of {sorted(PIECES)}")

    cmd = f"move_{color}_{piece}_from_{from_square}_to_{to_square}"
    _send(cmd)

    for listener in list(_move_listeners):
        listener(color, piece, from_square, to_square)


def _stringify(payload: Any) -> str:
    """Return a readable string representation for ``payload``."""

    if isinstance(payload, str):
        return payload
    return json.dumps(payload, sort_keys=True)


FILES = ("a", "b", "c", "d", "e", "f", "g", "h")
_PLURAL_NAMES = {
    "pawn": "pawns",
    "rook": "rooks",
    "knight": "knights",
    "bishop": "bishops",
    "queen": "queens",
    "king": "kings",
}


def _square_order(square: str) -> int:
    """Return an index that orders squares from a1 to h8."""

    file_index = FILES.index(square[0]) if square and square[0] in FILES else -1
    try:
        rank_index = int(square[1:]) - 1
    except ValueError:
        rank_index = -1
    return rank_index * 8 + file_index


def _join_locations(locations: List[str]) -> str:
    """Return a natural language list of locations."""

    if not locations:
        return ""
    if len(locations) == 1:
        return locations[0]
    if len(locations) == 2:
        return f"{locations[0]} and {locations[1]}"
    return ", ".join(locations[:-1]) + f", and {locations[-1]}"


def _describe_pieces(pieces: List[Dict[str, Any]]) -> str:
    """Create a human readable description of all piece locations."""

    descriptions = []
    for color in sorted(COLORS):
        grouped: Dict[str, List[str]] = {}
        for piece in pieces:
            if piece.get("color") != color:
                continue
            piece_type = piece.get("piece") or piece.get("type")
            square = piece.get("square")
            if not piece_type or not square:
                continue
            grouped.setdefault(piece_type, []).append(square)

        if not grouped:
            continue

        parts: List[str] = []
        for piece_type in sorted(grouped.keys()):
            squares = sorted(grouped[piece_type], key=_square_order)
            name = piece_type if len(squares) == 1 else _PLURAL_NAMES.get(piece_type, f"{piece_type}s")
            parts.append(f"{name} on {_join_locations(squares)}")

        descriptions.append(f"{color.capitalize()} pieces: {'; '.join(parts)}")

    return "\n".join(descriptions)


def get_context(*, full: bool = False) -> str:
    """Fetch the current board status from the server.

    Parameters
    ----------
    full: bool, optional
        When ``True`` include a piece-by-piece location breakdown in the
        returned string. Defaults to ``False``.

    Returns
    -------
    str
        When ``full`` is ``False`` (default) a string describing the current
        board context as returned by the server. When ``full`` is ``True`` a
        multi-line human readable summary of where each piece is located.
    """

    response = requests.get(f"{SERVER_URL}/context", timeout=5)
    response.raise_for_status()

    try:
        data: Any = response.json()
    except ValueError:
        text = response.text.strip()
        if full:
            return text
        return text

    if isinstance(data, dict):
        if full:
            state = data.get("state", {})
            pieces = state.get("pieces") if isinstance(state, dict) else None
            if isinstance(pieces, list):
                description = _describe_pieces(pieces)
                context_summary = data.get("context")
                if isinstance(context_summary, dict):
                    context_summary = {
                        key: value
                        for key, value in context_summary.items()
                        if key not in _EXCLUDED_CONTEXT_KEYS
                    }
                if context_summary:
                    summary = _stringify(context_summary)
                    return f"{summary}\n{description}" if description else summary
                return description or _stringify(pieces)
            return _stringify(data)
        for key in ("context", "status", "data"):
            if key in data:
                return _stringify(data[key])

    if full:
        return _stringify(data)
    return _stringify(data)

__all__ = ["move_piece", "get_context", "register_move_listener"]
