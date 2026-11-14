"""`vyrse_controls`: media keys, now playing, volume, brightness, lock and clipboard (Windows APIs, no windows)."""
from __future__ import annotations

import base64
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Dict

_SCRIPT = Path(__file__).resolve().parent / "controls.ps1"
_SPOTIFY = Path(__file__).resolve().parent / "spotify.ps1"

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_controls",
    "description": (
        "Instant PC controls. action=play (query: start a song, artist, album, playlist or mood on Spotify, e.g. "
        "'play lofi on spotify' -> query 'lofi', 'play Blinding Lights' -> query 'Blinding Lights'; it reports what really "
        "started); action=media (command play_pause|next|previous|stop on whatever is already loaded: works with Spotify, "
        "YouTube, any player); now_playing (what's playing, which app); volume (command get|set|up|down|mute|unmute|"
        "toggle_mute, level 0-100 for set or a step for up/down); brightness (level 0-100, or omit to read it); "
        "lock (lock the PC); screen_off (turn the monitors off, e.g. bedtime; a key or the mouse wakes them); clipboard_get (what the user copied: text, files, whether it's an image); "
        "clipboard_set (text: put text on the clipboard, e.g. after fixing or translating what they copied); clipboard_history "
        "(text they copied earlier, newest first: query words, hours back; 'paste the link I copied this morning' = find it, "
        "then clipboard_set it); clipboard_forget (wipe that history). "
        "For 'summarise/translate/fix what I copied', read it with clipboard_get first."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["play", "media", "now_playing", "volume", "brightness", "lock", "screen_off",
                                                  "clipboard_get", "clipboard_set", "clipboard_history", "clipboard_forget"]},
            "query": {"type": "string", "description": "For play: what to play (song, artist, playlist or mood). For clipboard_history: words to look for."},
            "hours": {"type": "number", "description": "For clipboard_history: only the last N hours."},
            "command": {"type": "string", "description": "media: play_pause|next|previous|stop; volume: get|set|up|down|mute|unmute|toggle_mute."},
            "level": {"type": "number", "description": "volume set (0-100) or up/down step; brightness 0-100."},
            "text": {"type": "string", "description": "For clipboard_set."},
        },
        "required": ["action"],
    },
}


def run(request: Dict[str, Any], timeout: int = 20, script: Path = _SCRIPT) -> Dict[str, Any]:
    from hermes_cli._subprocess_compat import windows_hide_flags

    payload = base64.b64encode(json.dumps(request).encode("utf-8")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Request", payload],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        stdin=subprocess.DEVNULL, creationflags=windows_hide_flags(),
    )
    lines = [line for line in (result.stdout or "").splitlines() if line.strip().startswith("{")]
    if lines:
        return json.loads(lines[-1])
    detail = (result.stderr or result.stdout or "no output").strip().splitlines()
    return {"ok": False, "error": f"controls helper failed: {detail[0] if detail else 'unknown error'}"}


_MEDIA_ALIASES = {"play": "play_pause", "pause": "play_pause", "resume": "play_pause", "toggle": "play_pause",
                  "skip": "next", "prev": "previous", "back": "previous"}


def play_query(raw: str) -> str:
    """What to search Spotify for: the request minus 'on Spotify', 'some', 'a song called' and the like."""
    q = re.sub(r"(?:^|\s+)(?:(?:on|in|from|with|using)\s+)?spotify\W*$", "", raw.strip(), flags=re.I)
    q = re.sub(r"^(?:some|a few|the song|a song(?: called)?|the track|songs? by|music by)\s+", "", q, flags=re.I)
    return q.strip(" .!?\"'")


def _play(params: Dict[str, Any]) -> str:
    query = play_query(str(params.get("query") or params.get("text") or ""))
    if not query:
        return json.dumps({"ok": False, "error": "Say what to play."})
    try:
        return json.dumps(run({"query": query}, timeout=45, script=_SPOTIFY), ensure_ascii=False)
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": "Spotify didn't respond in time. Say so; don't claim it's playing."})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"Couldn't start Spotify: {exc}"})


def handle(params: Dict[str, Any], **_: Any) -> str:
    if params.get("action") == "media" and str(params.get("command") or "").lower() in _MEDIA_ALIASES:
        params = {**params, "command": _MEDIA_ALIASES[str(params["command"]).lower()]}
    if params.get("action") in ("clipboard_history", "clipboard_forget"):
        from .. import clipboard_memory

        if params["action"] == "clipboard_forget":
            return json.dumps(clipboard_memory.forget_all())
        return json.dumps(clipboard_memory.history(params.get("query") or "", 10, params.get("hours")), ensure_ascii=False)
    if params.get("action") == "play":
        return _play(params)
    request = {k: params[k] for k in ("action", "command", "level", "text") if params.get(k) is not None}
    try:
        return json.dumps(run(request), ensure_ascii=False)
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": "Windows didn't respond in time."})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"Couldn't do that: {exc}"})
