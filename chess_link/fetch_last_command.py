"""Fetch the latest Gemini command output for a user by key.

This script retrieves rows from the ``command_outputs`` table using the
Supabase REST API so it can run in environments where handing out the
service-role key would be unsafe. It only needs the public anon key and a
user's ``user_key`` value.

Usage::

    python examples/fetch_last_command.py

The script expects the ``requests`` package. Install it with::

    pip install requests

To keep the anon key scoped, enable row level security on the
``command_outputs`` table and add a policy that compares the row ``user_key`` to
an HTTP header. Example::

    alter table command_outputs enable row level security;
    create policy "Allow select by command key" on command_outputs
      for select using (
        auth.role() = 'anon' and
        user_key = current_setting('request.headers', true)::json->>'x-client-user-key'
      );

The script sends the ``X-Client-User-Key`` header automatically so individual
users can fetch only their own records.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

import requests

DEFAULT_TIMEOUT = 10


def _get_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def _rest_endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    return f"{base}/rest/v1/command_outputs"


def fetch_last_command(
    *,
    base_url: str,
    anon_key: str,
    user_key: str,
    session: Optional[requests.Session] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, Any] | None:
    """Return the most recent command output for ``user_key`` or ``None``."""

    http = session or requests.Session()
    params = {
        "select": "user_key,last_command,last_response,updated_at",
        "user_key": f"eq.{user_key}",
        "order": "updated_at.desc",
        "limit": 1,
    }
    headers = {
        "apikey": anon_key,
        "Authorization": f"Bearer {anon_key}",
        "X-Client-User-Key": user_key,
        "Accept": "application/json",
    }

    response = http.get(
        _rest_endpoint(base_url),
        params=params,
        headers=headers,
        timeout=timeout,
    )
    response.raise_for_status()

    data = response.json()
    if isinstance(data, list) and data:
        return data[0]
    return None


def main() -> None:
    base_url = "https://acpblsopqcmqtjsroggb.supabase.co"
    anon_key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjcGJsc29wcWNtcXRqc3JvZ2diIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgxODE1MDYsImV4cCI6MjA3Mzc1NzUwNn0.g-MnigvYHAI1NH0Q1XVKFzsE2uqMJfPFhqWBjlRvxog"
    user_key = ""

    try:
        record = fetch_last_command(base_url=base_url, anon_key=anon_key, user_key=user_key)
    except requests.RequestException as exc:
        print("Failed to fetch Gemini command output:", exc, file=sys.stderr)
        sys.exit(1)

    if not record:
        print("No Gemini command output was found for that key.")
        return

    print("User key:", record["user_key"])
    print("Last command:", record.get("last_command") or "(none)")
    print("Last response:")
    print(record.get("last_response") or "(empty response)")
    if record.get("updated_at"):
        print("Updated at:", record["updated_at"])


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:  # pragma: no cover - example script convenience
        sys.exit(130)
