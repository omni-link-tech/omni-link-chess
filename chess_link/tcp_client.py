#!/usr/bin/env python3
"""Utility TCP client that prints chess commands forwarded by ``link_tcp.py``.

The :mod:`chess_link.link_tcp` module forwards every recognised command to a
TCP endpoint using :class:`chess_link.omnilink.OmniLinkTCPAdapter`.  This script acts as
that endpoint: it accepts incoming connections, reads the payload sent by the
adapter and pretty-prints it to standard output.

The defaults mirror those of :class:`~chess_link.omnilink.OmniLinkTCPAdapter` so the
client can run without additional configuration.  They can be overridden via
command line arguments or environment variables so that the client matches the
endpoint configured in :mod:`link_tcp`.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socketserver
import sys
from dataclasses import dataclass
from typing import Any, Dict, Optional

from chess_api import move_piece


_DEFAULT_HOST = "0.0.0.0"
_DEFAULT_PORT = 8766
_DEFAULT_ENCODING = "utf-8"
_DEFAULT_DELIMITER = "\n"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None else value


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        logging.warning("Environment variable %s should be an integer (got %r)", name, value)
        return default


def _normalise_delimiter(value: Optional[str]) -> Optional[str]:
    """Translate escape sequences used by :class:`OmniLinkTCPAdapter`.

    ``link_tcp`` may be configured with delimiter strings like ``"\\n"`` or
    ``"\\r\\n"``.  The adapter replaces these with their actual control characters
    before sending data.  We mirror the same behaviour so that the TCP client
    can interpret payload boundaries correctly.
    """

    if value in (None, ""):
        return None

    if value == "\\n":
        return "\n"
    if value == "\\r\\n":
        return "\r\n"
    return value


@dataclass
class ClientConfig:
    host: str = _DEFAULT_HOST
    port: int = _DEFAULT_PORT
    encoding: str = _DEFAULT_ENCODING
    delimiter: Optional[str] = _DEFAULT_DELIMITER
    quiet: bool = False


# ---------------------------------------------------------------------------
# TCP server implementation
# ---------------------------------------------------------------------------


class CommandTCPServer(socketserver.ThreadingTCPServer):
    """Threaded TCP server that stores encoding/delimiter configuration."""

    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        RequestHandlerClass: type[CommandTCPHandler],
        *,
        encoding: str,
        delimiter: Optional[str],
    ) -> None:
        super().__init__(server_address, RequestHandlerClass)
        self.encoding = encoding
        self.delimiter = delimiter


class CommandTCPHandler(socketserver.StreamRequestHandler):
    """Handle incoming payloads from :class:`OmniLinkTCPAdapter`."""

    def handle(self) -> None:
        server: CommandTCPServer = self.server  # type: ignore[assignment]
        data = self.rfile.readline() if server.delimiter else self.rfile.read()
        if not data:
            return

        try:
            message = data.decode(server.encoding)
        except UnicodeDecodeError:
            logging.error(
                "Failed to decode payload from %s:%s", *self.client_address
            )
            return

        if server.delimiter:
            message = message.rstrip(server.delimiter)

        payload = message.strip()
        if not payload:
            logging.debug("Received empty payload")
            return

        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            parsed = None
            logging.info("Command: %s", payload)
        else:
            command = parsed.get("command")
            if command:
                logging.info("Command: %s", command)
            logging.debug("Full payload: %s", json.dumps(parsed, indent=2))

        self._maybe_move_piece(payload, parsed)

        sys.stdout.write(payload + "\n")
        sys.stdout.flush()

    # ------------------------------------------------------------------
    # Chess API integration helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _maybe_move_piece(payload: str, parsed: Optional[Dict[str, Any]]) -> None:
        """Attempt to move a chess piece based on ``payload`` information."""

        if parsed:
            vars_payload = parsed.get("vars")
            if isinstance(vars_payload, dict):
                move = CommandTCPHandler._extract_move_from_vars(vars_payload)
                if move and CommandTCPHandler._execute_move(*move):
                    return

            command_value = parsed.get("command")
            if isinstance(command_value, str):
                move = CommandTCPHandler._extract_move_from_command(command_value)
                if move and CommandTCPHandler._execute_move(*move):
                    return

        move = CommandTCPHandler._extract_move_from_command(payload)
        if move:
            CommandTCPHandler._execute_move(*move)

    @staticmethod
    def _extract_move_from_vars(vars_payload: Dict[str, Any]) -> Optional[tuple[str, str, str, str]]:
        try:
            color = str(vars_payload["color"]).lower()
            piece = str(vars_payload["piece"]).lower()
            from_square = str(vars_payload["location1"]).lower()
            to_square = str(vars_payload["location2"]).lower()
        except (KeyError, TypeError):
            return None

        if not all((color, piece, from_square, to_square)):
            return None
        return color, piece, from_square, to_square

    @staticmethod
    def _extract_move_from_command(command: str) -> Optional[tuple[str, str, str, str]]:
        parts = command.lower().split("_")
        if len(parts) != 7:
            return None

        move_prefix, color, piece, from_keyword, from_square, to_keyword, to_square = parts
        if move_prefix != "move" or from_keyword != "from" or to_keyword != "to":
            return None

        if not all((color, piece, from_square, to_square)):
            return None

        return color, piece, from_square, to_square

    @staticmethod
    def _execute_move(color: str, piece: str, from_square: str, to_square: str) -> bool:
        try:
            move_piece(color, piece, from_square, to_square)
        except Exception as exc:  # pragma: no cover - log unexpected failures
            logging.error(
                "Failed to execute move %s %s from %s to %s: %s",
                color,
                piece,
                from_square,
                to_square,
                exc,
            )
            return False

        logging.info(
            "Executed move: %s %s from %s to %s",
            color,
            piece,
            from_square,
            to_square,
        )
        return True


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str]) -> ClientConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host",
        default=None,
        help=(
            "Host/interface to bind to. Defaults to $TCP_CLIENT_HOST, falling "
            "back to 0.0.0.0."
        ),
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help=(
            "Port to listen on. Defaults to $TCP_CLIENT_PORT, then "
            "$TCP_ADAPTER_PORT, falling back to 8766."
        ),
    )
    parser.add_argument(
        "--encoding",
        default=None,
        help=(
            "Character encoding expected from link_tcp. Defaults to "
            "$TCP_CLIENT_ENCODING, then $TCP_ADAPTER_ENCODING, "
            "falling back to 'utf-8'."
        ),
    )
    parser.add_argument(
        "--delimiter",
        default=None,
        help=(
            "Line delimiter appended by link_tcp. Defaults to $TCP_CLIENT_DELIMITER, "
            "then $TCP_ADAPTER_DELIMITER, falling back to '\\n'."
        ),
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Reduce logging output."
    )

    args = parser.parse_args(argv)

    host = args.host or _env_str("TCP_CLIENT_HOST", _DEFAULT_HOST)
    port = args.port or _env_int(
        "TCP_CLIENT_PORT",
        _env_int("TCP_ADAPTER_PORT", _DEFAULT_PORT),
    )

    encoding = args.encoding or _env_str(
        "TCP_CLIENT_ENCODING",
        _env_str("TCP_ADAPTER_ENCODING", _DEFAULT_ENCODING),
    )

    delimiter_env = args.delimiter or _env_str(
        "TCP_CLIENT_DELIMITER",
        _env_str("TCP_ADAPTER_DELIMITER", _DEFAULT_DELIMITER),
    )
    delimiter = _normalise_delimiter(delimiter_env)

    return ClientConfig(
        host=host,
        port=port,
        encoding=encoding,
        delimiter=delimiter,
        quiet=args.quiet,
    )


def main(argv: Optional[list[str]] = None) -> int:
    config = _parse_args(argv or sys.argv[1:])
    logging.basicConfig(
        level=logging.WARNING if config.quiet else logging.INFO,
        format="[tcp_client] %(message)s",
    )

    server = CommandTCPServer(
        (config.host, config.port),
        CommandTCPHandler,
        encoding=config.encoding,
        delimiter=config.delimiter,
    )

    if config.delimiter:
        logging.info(
            "Listening on %s:%s (encoding=%s, delimiter=%r)",
            config.host,
            config.port,
            config.encoding,
            config.delimiter,
        )
    else:
        logging.info(
            "Listening on %s:%s (encoding=%s, delimiter disabled)",
            config.host,
            config.port,
            config.encoding,
        )

    # Gracefully exit on SIGTERM (helpful for container environments).
    def _handle_sigterm(_signum: int, _frame: Optional[object]) -> None:
        server.shutdown()

    try:
        signal.signal(signal.SIGTERM, _handle_sigterm)
    except ValueError:
        # Signals are not available on all platforms (e.g. Windows when running
        # in certain environments).  Failing silently keeps the client usable.
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Shutting down TCP client")
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":  # pragma: no cover - manual utility
    sys.exit(main())
