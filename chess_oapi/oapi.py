#!/usr/bin/env python3
# oapi.py — MQTT-only OAPI engine with solid pattern compiler
# Dependencies: paho-mqtt  (pip install paho-mqtt)

from __future__ import annotations

import json
import logging
import os
import re
import time
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Deque, Dict, Iterable, List, Optional, Pattern, Tuple, Union

# =========================================================
# Utilities / Types
# =========================================================

TypeConverter = Callable[[str], Any]

def _num_conv(s: str) -> Union[int, float]:
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    f = float(s)
    return int(f) if f.is_integer() else f

def _normalize_separators(text: str) -> str:
    """
    Normalize separators for matching:
      - strip
      - collapse whitespace to single space
      - convert spaces to underscores
    NOTE: we DO NOT lowercase to preserve captured values like 'C2'.
    """
    t = re.sub(r"\s+", " ", text.strip())
    return t.replace(" ", "_")

# =========================================================
# Type registry
# =========================================================

class TypeRegistry:
    """
    Holds named types mapping to (regex, converter).
    Converters receive str and return a typed value (or raise ValueError).
    """
    def __init__(self) -> None:
        self._types: Dict[str, Tuple[str, Optional[TypeConverter]]] = {}
        self._install_defaults()

    def _install_defaults(self) -> None:
        # Common text
        self.register("alpha", r"[A-Za-z]+")
        self.register("letters", r"[A-Za-z]+")
        self.register("word", r"[A-Za-z]+")
        self.register("lower", r"[a-z]+")
        self.register("upper", r"[A-Z]+")
        self.register("slug", r"[A-Za-z0-9_-]+")
        self.register("alnum", r"[A-Za-z0-9]+")
        self.register("alphanumeric", r"[A-Za-z0-9]+")

        # Numbers / bools
        self.register("int", r"-?\d+", lambda s: int(s))
        self.register("float", r"-?\d+(?:\.\d+)?", lambda s: float(s))
        self.register("num", r"-?\d+(?:\.\d+)?", _num_conv)
        self.register("digit", r"\d", lambda s: int(s))
        self.register("digits", r"\d+", lambda s: int(s))
        self.register("bool", r"(?:true|false|0|1)", lambda s: s.lower() in ("true", "1"))

        # IDs / time-ish (kept as strings)
        self.register("uuid", r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
        self.register("date", r"\d{4}-\d{2}-\d{2}")
        self.register("time", r"\d{2}:\d{2}(?::\d{2})?")
        self.register("datetime", r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?")

        # Anything (greedy)
        self.register("any", r".+")

    def register(self, name: str, regex: str, converter: Optional[TypeConverter] = None) -> None:
        self._types[name.lower()] = (regex, converter)

    def get(self, name: str) -> Optional[Tuple[str, Optional[TypeConverter]]]:
        return self._types.get(name.lower())

    def available(self) -> Dict[str, str]:
        return {k: v[0] for k, v in self._types.items()}

# =========================================================
# Pattern compilation and matching
# =========================================================

# Token format inside []:
#   [name:type]      named + typed
#   [name]           named, default token regex
#   [:type]          unnamed, typed
#   [/regex/]        unnamed, custom regex
#   [name:/regex/]   named, custom regex
_TOKEN_PAT = re.compile(r"\[([^\]]+)\]")   # inner contents only
_DEFAULT_TOKEN_RX = r"[^_]+"               # stops at underscore

@dataclass
class CompiledPattern:
    template: str
    regex: Pattern[str]
    var_names: List[str]
    var_types: List[Optional[str]]
    text: str  # normalized template text

def _parse_token(token: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Returns (name, type_name, regex_override)
    """
    token = token.strip()
    if token.startswith("/") and token.endswith("/") and len(token) > 2:
        return None, None, token[1:-1]
    if ":" in token:
        left, right = token.split(":", 1)
        left, right = left.strip(), right.strip()
        if right.startswith("/") and right.endswith("/") and len(right) > 2:
            name = left or None
            return name, None, right[1:-1]
        name = left or None
        typ = right or None
        return name, typ, None
    if token:
        return token, None, None
    return None, None, None

def _compile_template(template: str, types: TypeRegistry) -> CompiledPattern:
    """
    Compile a human-readable template into a strict regex with capturing groups.
    Both template and inputs are normalized with _normalize_separators (NOT lowercased).
    Regex is compiled with IGNORECASE; captures preserve original case.
    """
    norm = _normalize_separators(template)
    var_names: List[str] = []
    var_types: List[Optional[str]] = []
    pieces: List[str] = []
    last = 0

    for m in _TOKEN_PAT.finditer(norm):
        pieces.append(re.escape(norm[last:m.start()]))

        name, typ, rx_override = _parse_token(m.group(1))

        if rx_override:
            cap_rx = f"({rx_override})"
        elif typ:
            spec = types.get(typ)
            if not spec:
                raise ValueError(f"Unknown type '{typ}' in template: {template}")
            rx, _ = spec
            cap_rx = f"({rx})"
        else:
            cap_rx = f"({_DEFAULT_TOKEN_RX})"

        if not name:
            name = f"var{len(var_names) + 1}"

        var_names.append(name)
        var_types.append(typ)
        pieces.append(cap_rx)
        last = m.end()

    pieces.append(re.escape(norm[last:]))

    full_rx = "^" + "".join(pieces) + "$"
    return CompiledPattern(
        template=template,
        regex=re.compile(full_rx, flags=re.IGNORECASE),
        var_names=var_names,
        var_types=var_types,
        text=norm,
    )

# =========================================================
# Engine
# =========================================================

@dataclass
class Event:
    command: str
    text: str
    template: Optional[str]
    normalized_template: Optional[str]
    vars: Dict[str, Any]
    meta: Dict[str, Any]
    timestamp: float

Handler = Callable[[Dict[str, Any]], Any]
Predicate = Callable[[Dict[str, Any]], bool]

class OAPIEngine:
    """
    Pattern-driven command engine with routing, middleware, metrics, and history.
    """
    def __init__(self, patterns: Iterable[str], types: Optional[TypeRegistry] = None, keep_history: int = 200) -> None:
        self.types = types or TypeRegistry()
        self._compiled: List[CompiledPattern] = []
        self._templates: List[str] = []
        self._handlers: List[Tuple[Predicate, Handler]] = []
        self._before: List[Handler] = []
        self._after: List[Handler] = []

        self.metrics = Counter()
        self.history: Deque[Event] = deque(maxlen=keep_history)

        for t in patterns:
            self.add_template(t)

    # Templates
    def add_template(self, template: str) -> None:
        cp = _compile_template(template, self.types)
        self._compiled.append(cp)
        self._templates.append(template)

    @property
    def templates(self) -> List[str]:
        return list(self._templates)

    # Routing
    def on(self, predicate: Predicate, handler: Handler) -> None:
        self._handlers.append((predicate, handler))

    def on_template(self, template: str, handler: Handler) -> None:
        norm = _normalize_separators(template)
        self._handlers.append((lambda e: e.get("normalized_template") == norm, handler))

    def before(self, handler: Handler) -> None:
        self._before.append(handler)

    def after(self, handler: Handler) -> None:
        self._after.append(handler)

    # Parsing and handling
    def parse(self, text: str) -> Dict[str, Any]:
        tnorm = _normalize_separators(text)
        for cp in self._compiled:
            m = cp.regex.match(tnorm)
            if not m:
                continue
            values = m.groups()
            out: Dict[str, Any] = {}
            for name, typ, val in zip(cp.var_names, cp.var_types, values):
                if typ:
                    spec = self.types.get(typ)
                    if spec and spec[1]:
                        try:
                            out[name] = spec[1](val)
                        except Exception:
                            out[name] = val
                    else:
                        out[name] = val
                else:
                    out[name] = val
            return {
                "ok": True,
                "template": cp.template,
                "normalized_template": cp.text,
                "vars": out,
            }
        return {"ok": False, "template": None, "normalized_template": None, "vars": {}}

    def handle(self, text: str, meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        meta = meta or {}
        ts = time.time()
        parsed = self.parse(text)
        evt: Dict[str, Any] = {
            "command": text,
            "text": _normalize_separators(text),
            "template": parsed.get("template"),
            "normalized_template": parsed.get("normalized_template"),
            "vars": parsed.get("vars", {}),
            "meta": meta,
            "timestamp": ts,
        }

        # history + metrics
        self.history.append(Event(**evt))
        self.metrics["handle.calls"] += 1
        self.metrics[f"handle.ok.{bool(parsed.get('ok'))}"] += 1

        # before middleware
        for h in self._before:
            try:
                h(evt)
            except Exception as e:
                logging.exception("Error in before-handler: %s", e)

        # routing
        result: Any = None
        for pred, handler in self._handlers:
            try:
                if pred(evt):
                    result = handler(evt)
                    break
            except Exception as e:
                logging.exception("Handler error: %s", e)
                result = {"error": str(e)}
                break

        # after middleware
        for h in self._after:
            try:
                h(evt)
            except Exception as e:
                logging.exception("Error in after-handler: %s", e)

        return {
            "ok": bool(parsed.get("ok")),
            "template": evt["template"],
            "normalized_template": evt["normalized_template"],
            "vars": evt["vars"],
            "result": result,
            "meta": meta,
            "timestamp": ts,
        }

# =========================================================
# Pattern file loader (exported)
# =========================================================

from inspect import getsourcefile, stack

def load_patterns_from_file(path: Union[str, Path], types: Optional[TypeRegistry] = None) -> List[str]:
    """
    Lines are templates; '#' starts a comment. Blank lines ignored.
    Robustness features:
      - Resolves relative paths against the caller's directory if needed.
      - Reads with utf-8-sig to ignore BOMs.
      - Auto-unquotes lines wrapped in "..." or '...'.
    """
    p = Path(path)
    tried: List[Path] = []

    def _read_file(pp: Path) -> List[str]:
        text = pp.read_text(encoding="utf-8-sig")
        out: List[str] = []
        for line in text.splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
                s = s[1:-1].strip()
            if s:
                out.append(s)
        return out

    # 1) as-is
    tried.append(p)
    if p.exists():
        return _read_file(p)

    # 2) relative to caller
    try:
        caller_file = getsourcefile(stack()[1].frame) or ""
        base = Path(caller_file).resolve().parent if caller_file else Path.cwd()
    except Exception:
        base = Path.cwd()
    p2 = (base / p).resolve()
    if p2.exists():
        tried.append(p2)
        return _read_file(p2)

    # 3) relative to CWD
    p3 = Path.cwd() / p
    if p3.exists():
        tried.append(p3)
        return _read_file(p3)

    raise FileNotFoundError(f"Patterns file not found. Tried: {', '.join(str(x) for x in tried)}")

# =========================================================
# MQTT bridge + context publishing
# =========================================================
# Env (defaults tuned for Mosquitto w/ WebSockets):
#   MQTT_HOST              default: "localhost"
#   MQTT_TRANSPORT         default: "websockets"  (alternatives: "tcp")
#   MQTT_PORT              default: 9001 (WS) | 1883 (TCP)
#   MQTT_USERNAME          optional
#   MQTT_PASSWORD          optional
#   MQTT_COMMAND_TOPIC     default: "olink/commands"
#   MQTT_FEEDBACK_TOPIC    default: "olink/commands_feedback"
#     (legacy fallback: MQTT_RESPONSE_TOPIC if set)
#   MQTT_CONTEXT_TOPIC     default: "olink/context"
#   MQTT_QOS_SUB           default: 0
#   MQTT_QOS_PUB           default: 0
#   MQTT_KEEPALIVE         default: 60
#   MQTT_CLIENT_ID         optional client id
#
# Command payloads accepted:
#   - Raw string: "move_white_knight_from_C2_to_C3"
#   - JSON:
#       {
#         "command": "move_white_knight_from_C2_to_C3",
#         "meta": {...},
#         "reply_to": "custom/topic"   # optional override for feedback
#       }
#
# Feedback publishing:
#   - Uses payload.reply_to OR meta.reply_to OR MQTT_FEEDBACK_TOPIC.
#   - Payload is ONLY: {"feedback": true|false}
#
# Context publishing:
#   - Only when give_context("<string>") is called.

try:
    import paho.mqtt.client as _mqtt  # type: ignore
except Exception:
    _mqtt = None  # optional until used

# Global bridge singleton so give_context() can publish
_BRIDGE_SINGLETON: Optional["OAPIMQTTBridge"] = None

class OAPIMQTTBridge:
    """MQTT <-> OAPIEngine bridge; publishes only {'feedback': bool}. Context via give_context()."""
    def __init__(
        self,
        engine: OAPIEngine,
        host: Optional[str] = None,
        port: Optional[int] = None,
        command_topic: Optional[str] = None,
        response_topic: Optional[str] = None,   # kept for API compat; mapped to feedback
        username: Optional[str] = None,
        password: Optional[str] = None,
        transport: Optional[str] = None,
        keepalive: Optional[int] = None,
        client_id: Optional[str] = None,
        qos_sub: Optional[int] = None,
        qos_pub: Optional[int] = None,
        log: bool = True,
    ) -> None:
        if _mqtt is None:
            raise RuntimeError("paho-mqtt is required. Install: pip install paho-mqtt")

        self.engine = engine
        self.log = log

        self.transport = (transport or os.environ.get("MQTT_TRANSPORT") or "websockets").lower()
        default_port = 9001 if self.transport == "websockets" else 1883
        self.host = host or os.environ.get("MQTT_HOST", "localhost")
        self.port = int(port if port is not None else int(os.environ.get("MQTT_PORT", str(default_port))))

        self.command_topic = command_topic or os.environ.get("MQTT_COMMAND_TOPIC", "olink/commands")

        # Feedback topic selection precedence:
        env_feedback = os.environ.get("MQTT_FEEDBACK_TOPIC")
        env_legacy = os.environ.get("MQTT_RESPONSE_TOPIC")  # legacy fallback
        self.response_topic = (
            response_topic
            or env_feedback
            or env_legacy
            or "olink/commands_feedback"
        )

        # Context topic
        self.context_topic = os.environ.get("MQTT_CONTEXT_TOPIC", "olink/context")

        self.username = username or os.environ.get("MQTT_USERNAME")
        self.password = password or os.environ.get("MQTT_PASSWORD")
        self.keepalive = int(keepalive if keepalive is not None else int(os.environ.get("MQTT_KEEPALIVE", "60")))
        self.qos_sub = int(qos_sub if qos_sub is not None else int(os.environ.get("MQTT_QOS_SUB", "0")))
        self.qos_pub = int(qos_pub if qos_pub is not None else int(os.environ.get("MQTT_QOS_PUB", "0")))
        self.client = _mqtt.Client(transport=self.transport, client_id=(client_id or os.environ.get("MQTT_CLIENT_ID")))
        if self.username:
            self.client.username_pw_set(self.username, self.password)

        # callbacks
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message

        # register singleton
        global _BRIDGE_SINGLETON
        _BRIDGE_SINGLETON = self

    # ----- Context publishing helper (used by give_context)
    def publish_context(self, context_str: str) -> None:
        """Publish the provided context string to the context topic."""
        try:
            payload = json.dumps({"context": str(context_str)})
            self.client.publish(self.context_topic, payload, qos=self.qos_pub)
            if self.log:
                print(f"[OAPIMQTT] Context -> {self.context_topic}: {payload}")
        except Exception as e:
            print(f"[OAPIMQTT] Context publish error: {e}")

    def _on_connect(self, client: "_mqtt.Client", _ud, _flags, rc: int):
        if rc == 0:
            if self.log:
                print(f"[OAPIMQTT] Connected {self.host}:{self.port} (transport={self.transport})")
            client.subscribe(self.command_topic, qos=self.qos_sub)
            if self.log:
                print(f"[OAPIMQTT] Subscribed to {self.command_topic}")
            # NOTE: No automatic context publishing here.
        else:
            print(f"[OAPIMQTT] Connect failed: rc={rc}")

    def _on_message(self, client: "_mqtt.Client", _ud, msg: "_mqtt.MQTTMessage"):
        # Accept raw or JSON
        try:
            payload_text = msg.payload.decode("utf-8", "replace")
            data = None
            try:
                data = json.loads(payload_text)
            except json.JSONDecodeError:
                pass

            if isinstance(data, dict):
                command = data.get("command")
                meta: Dict[str, Any] = data.get("meta") or {}
                reply_to = data.get("reply_to") or meta.get("reply_to")
            else:
                command = payload_text
                meta = {}
                reply_to = None

        except Exception as exc:
            print(f"[OAPIMQTT] Decode error: {exc}")
            client.publish(self._resolve_reply_to(None), json.dumps({"feedback": False}), qos=self.qos_pub)
            return

        if self.log:
            print(f"[OAPIMQTT] Rx {msg.topic}: {command!r}")

        if not isinstance(command, str) or not command.strip():
            client.publish(self._resolve_reply_to(reply_to), json.dumps({"feedback": False}), qos=self.qos_pub)
            return

        # Handle
        feedback = False
        try:
            res = self.engine.handle(command, meta=meta)
            # Success criteria: parsing ok AND no handler error dict in result
            result = res.get("result")
            handler_failed = isinstance(result, dict) and bool(result.get("error"))
            feedback = bool(res.get("ok")) and not handler_failed
        except Exception as exc:
            print(f"[OAPIMQTT] Handler exception: {exc}")
            feedback = False

        # Publish ONLY {"feedback": bool} to feedback topic or reply_to
        out_topic = self._resolve_reply_to(reply_to)
        client.publish(out_topic, json.dumps({"feedback": feedback}), qos=self.qos_pub)
        if self.log:
            print(f"[OAPIMQTT] Tx -> {out_topic}: {{'feedback': {feedback}}}")

    def _resolve_reply_to(self, reply_to: Optional[str]) -> str:
        return reply_to or self.response_topic

    # lifecycle
    def start(self) -> "OAPIMQTTBridge":
        self.client.connect(self.host, self.port, keepalive=self.keepalive)
        self.client.loop_start()
        if self.log:
            print(f"[OAPIMQTT] Listening… host={self.host} port={self.port} sub={self.command_topic}")
        return self

    def loop_forever(self) -> None:
        self.client.connect(self.host, self.port, keepalive=self.keepalive)
        if self.log:
            print("[OAPIMQTT] Listening… (Ctrl+C to exit)")
        try:
            self.client.loop_forever()
        except KeyboardInterrupt:
            pass

# =========================================================
# Public API: give_context
# =========================================================

def give_context(context_str: str) -> None:
    """
    Publish a context string to MQTT_CONTEXT_TOPIC (default 'olink/context').
    Requires that an OAPIMQTTBridge has been instantiated (sets a module singleton).
    """
    global _BRIDGE_SINGLETON
    if _BRIDGE_SINGLETON is None:
        raise RuntimeError("OAPIMQTTBridge is not initialized; create the bridge before calling give_context().")
    _BRIDGE_SINGLETON.publish_context(context_str)

# =========================================================
# Example (commented)
# =========================================================
# if __name__ == "__main__":
#     types = TypeRegistry()
#     patterns = [
#         "move_[color]_[piece]_from_[location1]_to_[location2]",
#         "say [text:any]",
#     ]
#     engine = OAPIEngine(patterns, types=types)
#
#     def handle_any(evt):
#         print("EVENT VARS:", evt["vars"])
#         # return {"error": "something"}  # would cause feedback:false
#         return {"ack": True}
#     engine.on(lambda e: True, handle_any)
#
#     bridge = OAPIMQTTBridge(engine).start()
#     # Example usage:
#     # give_context("context: system ready")
#     bridge.loop_forever()
