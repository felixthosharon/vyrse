"""Music VYRSE is in charge of: shared by every VYRSE window (PC and phone) through one small file.

The now-playing pill shows only music that VYRSE started or controlled (Felix, 2026-11-24: "keep the pill in all
chats unless it's not played from vyrse app"), in every chat and on every device at once. Each change bumps
`version`; the apps ask for it every few seconds (a file read, no PowerShell) and re-read what's playing only when
it moved. Hiding the pill on one device hides it on the other.

This module is loaded both as part of the plugin and standalone by the dashboard routes, so it keeps no state in
memory and imports nothing from the plugin.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

_lock = threading.Lock()
# Nothing playing for this long: the music VYRSE started is over, and the pill goes away.
IDLE_S = 10 * 60
_EMPTY: Dict[str, Any] = {"owned": False, "version": 0}


def _path() -> Path:
    try:
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or Path(os.environ.get("LOCALAPPDATA", ".")) / "hermes")
    return home / "vyrse" / "media.json"


def load() -> Dict[str, Any]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else dict(_EMPTY)
    except (OSError, ValueError):
        return dict(_EMPTY)


def _save(state: Dict[str, Any]) -> Dict[str, Any]:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)
    return state


def _change(**fields: Any) -> Dict[str, Any]:
    with _lock:
        state = load()
        state.update(fields)
        state["version"] = int(state.get("version") or 0) + 1
        state["changed_at"] = time.time()
        return _save(state)


def claim(result: Dict[str, Any], started: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """VYRSE started or controlled the music: the pill shows it everywhere. `started` = what a play request
    began ({query, kind, title, artist}), kept so a single song can carry on when it ends."""
    fields: Dict[str, Any] = {"owned": True, "app": result.get("app") or "", "title": result.get("title") or "",
                              "artist": result.get("artist") or "", "last_playing": time.time()}
    if started is not None:
        fields["started"] = started
    return _change(**fields)


def release(reason: str = "hidden") -> Dict[str, Any]:
    return _change(owned=False, released=reason, started=None)


def note(now: Dict[str, Any]) -> Dict[str, Any]:
    """What is playing right now (read by the app or the watcher). Ends VYRSE's claim when another app is
    playing, or nothing has played for a while. Bumps the version only when something the pill shows changed."""
    state = load()
    if not state.get("owned"):
        return state
    app = str(now.get("app") or "")
    other_app = bool(app and state.get("app") and _app_key(app) != _app_key(str(state["app"])))
    idle = not now.get("playing") and time.time() - float(state.get("last_playing") or 0) > IDLE_S
    if other_app or idle:
        return release("other app" if other_app else "idle")
    changed = {k: now.get(k) or "" for k in ("title", "artist") if (now.get(k) or "") != (state.get(k) or "")}
    if now.get("playing"):
        state["last_playing"] = time.time()
        with _lock:
            current = load()
            current["last_playing"] = state["last_playing"]
            _save(current)
    return _change(**changed) if changed else load()


def _app_key(app: str) -> str:
    """'Spotify.exe' and 'SpotifyAB.SpotifyMusic_…!Spotify' are the same app."""
    a = app.lower()
    for name in ("spotify", "chrome", "msedge", "firefox", "vlc"):
        if name in a:
            return name
    return a.split("!")[0]
