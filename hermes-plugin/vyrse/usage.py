"""Screen time, kept on this PC: which app is in front, minute by minute, so VYRSE can answer "how long have I
been gaming today?" or "what did I spend my day on?".

A sample every 20 s of the foreground window's program. Time away from the keyboard isn't counted, except while
a game is in front (controllers and cutscenes don't touch the keyboard). Games are recognised by where they're
installed (Steam, Epic, Riot, Xbox, GOG, EA, Ubisoft, Battle.net). Totals per day live in
%HERMES_HOME%/vyrse/usage/YYYY-MM-DD.json; nothing leaves the PC.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import logging
import os
import re
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)
TICK = 20.0
IDLE_AFTER = 300.0  # seconds without input before time stops counting (except games)
_GAME_DIRS = re.compile(
    r"\\(steamapps\\common|epic games|riot games|xboxgames|windowsapps\\microsoft\.(?:minecraft|gaming)|gog galaxy\\games|"
    r"gog games|ea games|electronic arts|ubisoft game launcher\\games|battle\.net|blizzard|rockstar games|"
    r"minecraft|roblox)\\",
    re.I,
)
_NOT_GAMES = {"steam", "steamwebhelper", "epicgameslauncher", "riotclientservices", "riotclientux", "battle.net",
              "eadesktop", "ubisoftconnect", "galaxyclient", "gamebar", "xboxapp"}
_FRIENDLY = {"code": "VS Code", "chrome": "Chrome", "msedge": "Edge", "firefox": "Firefox", "discord": "Discord",
             "spotify": "Spotify", "explorer": "File Explorer", "windowsterminal": "Terminal", "winword": "Word",
             "excel": "Excel", "powerpnt": "PowerPoint", "notepad": "Notepad", "vlc": "VLC", "obs64": "OBS",
             "valorant-win64-shipping": "VALORANT", "javaw": "Minecraft", "robloxplayerbeta": "Roblox",
             "applicationframehost": "Windows apps", "systemsettings": "Settings", "msedgewebview2": "Edge"}
_lock = threading.Lock()
_started = False
# the unbroken gaming stretch in progress: (game, started_at, last_seen)
_stretch: Optional[Tuple[str, float, float]] = None


def _dir() -> Path:
    home = Path(os.environ.get("HERMES_HOME") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "hermes")
    d = home / "vyrse" / "usage"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load(day: date) -> Dict[str, Any]:
    try:
        return json.loads((_dir() / f"{day.isoformat()}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"apps": {}, "games": {}}


def _save(day: date, data: Dict[str, Any]) -> None:
    path = _dir() / f"{day.isoformat()}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


class _LASTINPUT(ctypes.Structure):
    _fields_ = [("cbSize", wt.UINT), ("dwTime", wt.DWORD)]


def _idle_seconds() -> float:
    info = _LASTINPUT(ctypes.sizeof(_LASTINPUT), 0)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    return max(0.0, (ctypes.windll.kernel32.GetTickCount() - info.dwTime) / 1000.0)


def friendly(proc: str, exe: str = "") -> str:
    key = proc.lower().removesuffix(".exe")
    if key in _FRIENDLY:
        return _FRIENDLY[key]
    m = re.search(r"\\steamapps\\common\\([^\\]+)\\", exe, re.I) or re.search(r"\\(?:epic games|riot games|xboxgames)\\([^\\]+)\\", exe, re.I)
    if m:
        return m.group(1)
    return proc.removesuffix(".exe")


def is_game(proc: str, exe: str) -> bool:
    return proc.lower().removesuffix(".exe") not in _NOT_GAMES and bool(_GAME_DIRS.search(exe or ""))


def _title() -> str:
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    n = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    ctypes.windll.user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _private() -> bool:
    try:
        from . import ui_state

        return ui_state.load().get("mode") == "private"
    except Exception:
        return False


def _foreground() -> Optional[Tuple[str, str]]:
    import psutil

    hwnd = ctypes.windll.user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wt.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    try:
        p = psutil.Process(pid.value)
        return p.name(), p.exe()
    except (psutil.Error, OSError):
        return None


def sample(now: Optional[float] = None) -> None:
    """One tick: credit TICK seconds to whatever is in front (if the user is there or it's a game)."""
    global _stretch
    now = now or time.time()
    fg = _foreground()
    if fg is None:
        return
    proc, exe = fg
    game = is_game(proc, exe)
    if not game and _idle_seconds() > IDLE_AFTER:
        return
    name = friendly(proc, exe)
    if name.lower() in ("lockapp", "vyrse", "electron"):
        return
    day = date.fromtimestamp(now)
    title = "" if _private() else _clean_title(_title(), name)
    with _lock:
        data = _load(day)
        data["apps"][name] = round(data["apps"].get(name, 0) + TICK)
        # the timeline for Rewind: consecutive samples of the same window merge into one stretch
        tl = data.setdefault("timeline", [])
        if tl and tl[-1][2] == name and tl[-1][3] == title and now - tl[-1][1] <= TICK * 3:
            tl[-1][1] = round(now)
        else:
            tl.append([round(now - TICK), round(now), name, title])
        del tl[:-3000]
        if game:
            data["games"][name] = round(data["games"].get(name, 0) + TICK)
            # a stretch survives short breaks (alt-tab, loading screens) of up to 10 minutes
            if _stretch and _stretch[0] == name and now - _stretch[2] < 600:
                _stretch = (name, _stretch[1], now)
            else:
                _stretch = (name, now - TICK, now)
        _save(day, data)


def _clean_title(title: str, app: str) -> str:
    """The useful part of a window title (the document, page or chat), without the app's own name."""
    t = re.sub(r"\s+[-–—|]\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Visual Studio Code|Discord|Notepad|File Explorer|Brave)$", "", title.strip())
    t = re.sub(r"^\(\d+\)\s+", "", t)  # "(3) YouTube" -> "YouTube"
    return "" if t.lower() == app.lower() else t[:90]


def _prune(keep_days: int = 7) -> None:
    """The timeline is kept a week; daily totals stay (they're just numbers)."""
    cutoff = date.today() - timedelta(days=keep_days)
    for f in _dir().glob("*.json"):
        try:
            d = date.fromisoformat(f.stem)
        except ValueError:
            continue
        if d < cutoff:
            data = _load(d)
            if data.pop("timeline", None) is not None:
                _save(d, data)


def rewind(start: float, end: float, min_seconds: int = 60) -> List[Dict[str, Any]]:
    """What was in front between two times: stretches of at least `min_seconds`, short gaps merged."""
    out: List[Dict[str, Any]] = []
    day = date.fromtimestamp(start)
    while day <= date.fromtimestamp(end):
        for a, b, app, title in _load(day).get("timeline", []):
            if b < start or a > end:
                continue
            a, b = max(a, start), min(b, end)
            if out and out[-1]["app"] == app and out[-1]["title"] == title and a - out[-1]["_b"] <= 180:
                out[-1]["_b"] = b
            else:
                out.append({"_a": a, "_b": b, "app": app, "title": title})
        day += timedelta(days=1)
    rows = []
    for r in out:
        secs = r["_b"] - r["_a"]
        if secs >= min_seconds:
            rows.append({"from": time.strftime("%H:%M", time.localtime(r["_a"])), "to": time.strftime("%H:%M", time.localtime(r["_b"])),
                         "minutes": round(secs / 60), "app": r["app"], "what": r["title"] or r["app"]})
    return rows


def start() -> None:
    global _started
    if _started or os.name != "nt" or not os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN"):
        return
    _started = True

    def run() -> None:
        try:
            _prune()
        except Exception:
            pass
        while True:
            time.sleep(TICK)
            try:
                sample()
            except Exception:
                logger.debug("vyrse: usage sample failed", exc_info=True)

    threading.Thread(target=run, daemon=True, name="vyrse-usage").start()


def _hm(seconds: float) -> str:
    m = int(round(seconds / 60))
    return f"{m // 60} h {m % 60} min" if m >= 60 else f"{m} min"


def tracked_since() -> Optional[date]:
    """The first day VYRSE recorded screen time on this PC."""
    days = sorted(p.stem for p in _dir().glob("????-??-??.json"))
    try:
        return date.fromisoformat(days[0]) if days else None
    except ValueError:
        return None


def report(period: str = "today", on: Optional[date] = None) -> Dict[str, Any]:
    """Screen time for today, the last 7 days (period=week) or one given day (`on`)."""
    days = 7 if period == "week" and on is None else 1
    today = on or date.today()
    apps: Dict[str, float] = {}
    games: Dict[str, float] = {}
    per_day: List[Dict[str, Any]] = []
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        data = _load(d)
        for k, v in data["apps"].items():
            apps[k] = apps.get(k, 0) + v
        for k, v in data["games"].items():
            games[k] = games.get(k, 0) + v
        per_day.append({"day": "Today" if d == date.today() else d.strftime("%a"), "gaming_min": round(sum(data["games"].values()) / 60),
                        "total_min": round(sum(data["apps"].values()) / 60)})
    top = sorted(apps.items(), key=lambda kv: -kv[1])[:10]
    out: Dict[str, Any] = {
        "ok": True, "period": period, "screen_time": _hm(sum(apps.values())), "gaming": _hm(sum(games.values())),
        "gaming_minutes": round(sum(games.values()) / 60),
        "top_apps": [{"app": k, "time": _hm(v), "minutes": round(v / 60), "game": k in games} for k, v in top],
        "note": "Counted by VYRSE since it started tracking (only while VYRSE runs; time away from the keyboard is skipped).",
    }
    first = tracked_since()
    out["tracked_since"] = first.isoformat() if first else None
    if on is not None:
        out["date"] = on.isoformat()
    if period == "week":
        out["days"] = per_day
    s = _stretch
    if s and time.time() - s[2] < 120:
        out["playing_now"] = {"game": s[0], "for": _hm(s[2] - s[1]), "minutes": round((s[2] - s[1]) / 60)}
    return out


def installed_games() -> List[str]:
    """Steam games installed on any library drive (names from their manifests)."""
    roots: List[Path] = []
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if base and (Path(base) / "Steam" / "steamapps").is_dir():
            roots.append(Path(base) / "Steam" / "steamapps")
    names: List[str] = []
    for root in list(roots):
        vdf = root / "libraryfolders.vdf"
        if vdf.is_file():
            for path in re.findall(r'"path"\s+"([^"]+)"', vdf.read_text(encoding="utf-8", errors="replace")):
                lib = Path(path.replace("\\\\", "\\")) / "steamapps"
                if lib.is_dir() and lib not in roots:
                    roots.append(lib)
    for root in roots:
        for acf in root.glob("appmanifest_*.acf"):
            raw = acf.read_bytes()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("cp1252", errors="replace")
            m = re.search(r'"name"\s+"([^"]+)"', text)
            if m and not re.search(r"redistributable|steamworks|proton|runtime", m.group(1), re.I):
                names.append(m.group(1))
    return sorted(set(names))
