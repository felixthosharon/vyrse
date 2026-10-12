"""Hermes browses in the user's real Chrome — a dedicated, persistent VYRSE profile.

`browser.cdp_url` points Hermes' built-in browser tools at a Chrome with remote debugging. This
`pre_tool_call` hook starts that Chrome on demand (Hermes' own `launch_chrome_debug`: the installed
Chrome binary, profile `%HERMES_HOME%\\chrome-debug`, visible window), so it runs beside the user's
personal Chrome. Logins made in that window persist. Chrome 136+ forbids automating the default
profile, which is why this is a separate profile rather than the everyday one.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


def _configured_port() -> Optional[int]:
    try:
        from hermes_cli.config import load_config_readonly
        url = str((load_config_readonly().get("browser") or {}).get("cdp_url") or "").strip()
    except Exception:
        return None
    if not url:
        return None
    parsed = urlparse(url if "://" in url else f"http://{url}")
    if parsed.hostname not in ("127.0.0.1", "localhost"):
        return None  # remote/cloud endpoints are not ours to launch
    return parsed.port


def ensure_browser(tool_name: str = "", **_: Any) -> None:
    """pre_tool_call: make sure the VYRSE Chrome is up before a browser tool runs. Never blocks the tool."""
    if not str(tool_name).startswith("browser_"):
        return None
    port = _configured_port()
    if port is None:
        return None
    try:
        from hermes_cli.browser_connect import discover_local_cdp_url, launch_chrome_debug
        if discover_local_cdp_url(port):
            return None
        result = launch_chrome_debug(port)
        if not result.launched:
            logger.warning("vyrse: could not start Chrome for browsing (attempts: %s)", result.attempts)
            return None
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline and not discover_local_cdp_url(port):
            time.sleep(0.25)
        logger.info("vyrse: VYRSE Chrome started on port %s", port)
    except Exception as exc:  # the tool will report its own failure; never crash the hook chain
        logger.warning("vyrse: browser launch hook failed: %s", exc)
    return None
