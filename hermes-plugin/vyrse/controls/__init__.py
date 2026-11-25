"""`vyrse_controls`: media keys, now playing, volume, brightness, lock and clipboard (Windows APIs, no windows)."""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

_SCRIPT = Path(__file__).resolve().parent / "controls.ps1"
_SPOTIFY = Path(__file__).resolve().parent / "spotify.ps1"

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_controls",
    "description": (
        "Instant PC controls. action=play (query: start a song, artist, album, playlist or mood on Spotify, e.g. "
        "'play lofi on spotify' -> query 'lofi', 'play Blinding Lights' -> query 'Blinding Lights', their own music -> 'my liked songs' or 'my <name> playlist' (keep the word 'my'); it reports what really "
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


def _claim(result: Dict[str, Any], started: Optional[Dict[str, Any]] = None) -> None:
    """The pill in every VYRSE window (PC and phone) shows music VYRSE started or controlled."""
    try:
        from .. import media_state

        media_state.claim(result, started)
    except Exception:
        pass


# A single song started from search plays once and Spotify stops at its end (2026-11-24: "after the specified song
# is over spotify pauses, why not auto play rest"). VYRSE watches that one song and, when it ends by itself,
# carries on with more by the same artist. Pausing it, playing something else, or hiding the pill ends the watch.
_watch_lock = threading.Lock()
_watch_id = 0
WATCH_SLACK_S = 4.0


def _song_ended(before: Dict[str, Any], now: Dict[str, Any]) -> bool:
    """`now` is the moment after `before`: the same song, stopped at (or reset from) its very end."""
    if not before or not now or now.get("playing"):
        return False
    if (now.get("title") or "") != (before.get("title") or ""):
        return False
    length, pos = now.get("length") or before.get("length"), now.get("position")
    if not length or pos is None:
        return False
    at_end = pos >= float(length) - WATCH_SLACK_S
    reset = pos <= 1.5 and (before.get("position") or 0) >= float(length) - 25
    return bool(at_end or reset)


def carry_on_query(title: str, artist: str) -> str:
    """What to play after a single song: the artist's music (Spotify finds their playlist or top songs)."""
    main = re.split(r",|&| feat\.? | ft\.? | x ", artist or "", maxsplit=1, flags=re.I)[0].strip()
    return main or title


def _watch(title: str, artist: str) -> None:
    global _watch_id
    with _watch_lock:
        _watch_id += 1
        me = _watch_id
    threading.Thread(target=_watch_loop, args=(me, title, artist), name="vyrse-song-watch", daemon=True).start()


def _watch_loop(me: int, title: str, artist: str) -> None:
    from .. import media_state

    last: Dict[str, Any] = {}
    deadline = time.time() + 2 * 3600
    while time.time() < deadline and me == _watch_id:
        try:
            now = run({"action": "now_playing"})
        except Exception:
            now = {}
        state = media_state.load()
        if not state.get("owned") or (now.get("title") and now.get("title") != title and now.get("playing")):
            return  # hidden, or something else is playing now
        if _song_ended(last or now, now) or (last and _song_ended(last, now)):
            query = carry_on_query(title, artist)
            try:
                out = run({"query": query}, timeout=45, script=_SPOTIFY)
            except Exception:
                out = {"ok": False}
            if out.get("ok"):
                _claim(out, {"query": query, "kind": "artist", "title": out.get("title"), "artist": out.get("artist")})
            return
        if now.get("title") == title:
            last = now
        # sleep until just before the end of the song, but look again at least every 30 s (pause, seek)
        left = (now.get("length") or 0) - (now.get("position") or 0) if now.get("playing") else 30
        time.sleep(max(2.0, min(30.0, left - 2.0 if left > 6 else 2.0)))


def _play(params: Dict[str, Any]) -> str:
    query = play_query(str(params.get("query") or params.get("text") or ""))
    if not query:
        return json.dumps({"ok": False, "error": "Say what to play."})
    try:
        out = run({"query": query}, timeout=45, script=_SPOTIFY)
        if out.get("ok"):
            kind = str(out.get("started") or "").split(" ", 1)[0]
            _claim(out, {"query": query, "kind": kind, "title": out.get("title"), "artist": out.get("artist")})
            if kind == "Song" and not os.environ.get("VYRSE_TEST_DRY"):
                _watch(str(out.get("title") or ""), str(out.get("artist") or ""))
        return json.dumps(out, ensure_ascii=False)
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
        out = run(request)
        if request.get("action") == "media" and out.get("ok") and out.get("title"):
            _claim(out)
        return json.dumps(out, ensure_ascii=False)
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": "Windows didn't respond in time."})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"Couldn't do that: {exc}"})
