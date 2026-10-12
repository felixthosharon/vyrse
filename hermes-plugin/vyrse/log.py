"""`vyrse_log`: keep running logs ("log study, chemistry, 20 minutes", "log water", "log my weight 71.4").

Each log is a CSV under %HERMES_HOME%/vyrse/logs/<name>.csv (time, entry, value, unit) so it survives
conversations and the user can open it anywhere. Adding to a log shows its card in the workspace: today's
total, the last 7 days and the latest entries, the new one called out.
"""
from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_log",
    "description": (
        "Running logs the user keeps by talking: study time, workouts, water, spending, mood, weight, sleep, "
        "anything. action=add (log = short name like 'study'; entry = what, e.g. 'chemistry'; value + unit = how "
        "much, e.g. 20 'min'); it saves the entry, returns today's and this week's totals and shows the log in "
        "the workspace. action=show (log) shows a log; action=list names all logs; action=undo removes the "
        "latest entry of a log. Use it whenever the user says 'log …', 'track …', 'add … to my …', or tells you "
        "something they did ('just finished 30 min of chemistry', 'drank 2 glasses of water'). Only things already "
        "done: goals and plans for later go to vyrse_workspace (rings, checklist). Past days: one add per day with "
        "`when` (e.g. 'yesterday', '3 days ago'). Keep each log in one unit."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["add", "show", "list", "undo"]},
            "log": {"type": "string", "description": "The log's short name, e.g. 'study', 'water', 'gym'."},
            "entry": {"type": "string", "description": "action=add: what this entry is, e.g. 'chemistry'."},
            "value": {"type": "number", "description": "action=add: how much (optional)."},
            "unit": {"type": "string", "description": "action=add: e.g. 'min', 'ml', 'km', '$' (optional)."},
            "when": {"type": "string", "description": "action=add: when it happened, if not now: 'yesterday', "
                                                      "'last night', '3 days ago', 'monday' or a date like 2026-10-10."},
        },
        "required": ["action"],
    },
}

_FIELDS = ("time", "entry", "value", "unit")


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")[:40]


def _dir() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "vyrse" / "logs"


def _path(name: str) -> Optional[Path]:
    slug = _slug(name)
    return _dir() / f"{slug}.csv" if slug else None


def read(name: str) -> List[Dict[str, Any]]:
    path = _path(name)
    if not path or not path.is_file():
        return []
    with path.open(encoding="utf-8", newline="") as fh:
        rows = []
        for r in csv.DictReader(fh):
            try:
                at = datetime.fromisoformat(r.get("time") or "")
            except ValueError:
                continue
            try:
                value: Optional[float] = float(r["value"]) if r.get("value") not in (None, "") else None
            except ValueError:
                value = None
            rows.append({"time": at, "entry": r.get("entry") or "", "value": value, "unit": r.get("unit") or ""})
        return rows


def _write(name: str, rows: List[Dict[str, Any]]) -> None:
    path = _path(name)
    assert path is not None
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(_FIELDS)
        for r in rows:
            w.writerow([r["time"].isoformat(timespec="seconds"), r["entry"], "" if r["value"] is None else _fmt(r["value"]), r["unit"]])
    tmp.replace(path)


def _fmt(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else f"{v:.2f}".rstrip("0").rstrip(".")


def summary(name: str, rows: List[Dict[str, Any]], *, now: Optional[datetime] = None, fresh: bool = False) -> Dict[str, Any]:
    """Totals for the card and for the model's reply. Logs without amounts count entries instead."""
    now = now or datetime.now()
    counted = not any(r["value"] is not None for r in rows)
    unit = "" if counted else next((r["unit"] for r in reversed(rows) if r["unit"]), "")
    amount = (lambda r: 1.0) if counted else (lambda r: r["value"] or 0.0)
    today = now.date()
    by_day: Dict[Any, float] = {}
    for r in rows:
        by_day[r["time"].date()] = by_day.get(r["time"].date(), 0.0) + amount(r)
    days = [today - timedelta(days=n) for n in range(6, -1, -1)]
    streak = 0
    while (today - timedelta(days=streak)) in by_day:
        streak += 1
    return {
        "name": name.strip().title()[:40] or "Log",
        "unit": unit or ("entries" if counted else ""),
        "today": by_day.get(today, 0.0),
        "today_count": sum(1 for r in rows if r["time"].date() == today),
        "week": sum(by_day.get(d, 0.0) for d in days),
        "streak": streak,
        "count": len(rows),
        "days": [{"label": "Today" if d == today else d.strftime("%a"), "value": by_day.get(d, 0.0)} for d in days],
        "entries": [{"at": r["time"].strftime("%a %H:%M"), "label": r["entry"][:80],
                     **({"value": r["value"]} if r["value"] is not None else {})} for r in reversed(rows[-8:])],
        "fresh": fresh,
    }


def artifact(name: str, info: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": f"log-{_slug(name)}", "title": f"{info['name']} log", "kind": "log", "log": info}


def _show(name: str, info: Dict[str, Any]) -> None:
    from . import workspace

    workspace.deliver({"action": "workspace", "op": "show", "artifact": artifact(name, info)})


def _amount(v: float, unit: str) -> str:
    return f"{_fmt(v)} {unit}".strip()


# Units a log may be kept in (so "1 h" lands in a minutes log as 60 min, and "minutes" matches "min").
_UNITS = {"min": "min", "mins": "min", "minute": "min", "minutes": "min", "m": "min",
          "h": "h", "hr": "h", "hrs": "h", "hour": "h", "hours": "h",
          "l": "L", "litre": "L", "liter": "L", "litres": "L", "liters": "L",
          "ml": "ml", "km": "km", "k": "km", "mi": "mi", "kg": "kg", "g": "g"}
_CONVERT = {("h", "min"): 60, ("min", "h"): 1 / 60, ("L", "ml"): 1000, ("ml", "L"): 1 / 1000, ("kg", "g"): 1000, ("g", "kg"): 1 / 1000}


def _unit(u: str) -> str:
    key = u.strip().lower().rstrip(".")
    return _UNITS.get(key, u.strip())


def _when(text: str, now: datetime) -> Optional[datetime]:
    """'yesterday', 'last night', '3 days ago', 'monday', '2026-10-10' -> that day (same clock time); None if unclear."""
    t = (text or "").strip().lower()
    if not t or t in ("now", "today", "just now", "tonight", "this morning"):
        return now
    if t in ("yesterday", "last night"):
        return now - timedelta(days=1)
    m = re.fullmatch(r"(\d+|a|one|two|three|four|five|six|seven)\s+(?:days?|nights?)\s+ago", t)
    if m:
        words = {"a": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7}
        n = int(m.group(1)) if m.group(1).isdigit() else words[m.group(1)]
        return now - timedelta(days=min(n, 3650))
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    t = re.sub(r"^(last|on)\s+", "", t)
    if t in days:
        back = (now.weekday() - days.index(t)) % 7 or 7
        return now - timedelta(days=back)
    try:
        day = datetime.fromisoformat(t[:10])
    except ValueError:
        return None
    return day.replace(hour=now.hour, minute=now.minute, second=now.second) if day.date() <= now.date() else None


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = params.get("action")
    name = str(params.get("log") or "").strip()
    try:
        if action == "list":
            logs = sorted(p.stem for p in _dir().glob("*.csv")) if _dir().is_dir() else []
            return json.dumps({"success": True, "logs": logs or [], "result": f"{len(logs)} logs" if logs else "no logs yet"})
        if not _slug(name):
            return json.dumps({"success": False, "error": "say which log, e.g. log='study'"})
        rows = read(name)
        if action == "add":
            value = params.get("value")
            spoken_unit = ""
            if isinstance(value, str):  # "20 min" in the value field: the number, and its unit if none was given
                m = re.match(r"\s*(\d+(?:\.\d+)?)\s*([A-Za-z]+)?", value)
                value = float(m.group(1)) if m else None
                spoken_unit = (m.group(2) or "") if m else ""
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                value = None
            entry = str(params.get("entry") or "").strip()[:120]
            unit = (str(params.get("unit") or "").strip() or spoken_unit)[:12]
            if value is None and not entry:
                return json.dumps({"success": False, "error": "add needs an entry or a value"})
            now = datetime.now().replace(microsecond=0)
            at = _when(str(params.get("when") or ""), now)
            if at is None:
                return json.dumps({"success": False, "error": f"couldn't tell when '{params.get('when')}' was; use "
                                                              "'yesterday', 'N days ago', a weekday or a date like 2026-10-10"})
            # One unit per log: convert what converts (1 h -> 60 min), refuse what doesn't ("3 chapters" in minutes).
            kept = next((r["unit"] for r in reversed(rows) if r["value"] is not None and r["unit"]), "")
            unit = _unit(unit)
            if value is not None and kept and unit != kept:
                factor = _CONVERT.get((unit, kept))
                if factor is None:
                    what = f"in {unit}" if unit else f"not an amount of {kept}"
                    return json.dumps({"success": False, "error": (
                        f"the '{name}' log is kept in {kept}, and this is {what}. Give it in {kept}, log it as an entry "
                        "without a value, or use another log. Goals for later aren't logs: show them as vyrse_workspace rings.")})
                value, unit = value * factor, kept
            rows.append({"time": at, "entry": entry, "value": None if value is None else float(value), "unit": unit})
            rows.sort(key=lambda r: r["time"])
            _write(name, rows)
            info = summary(name, rows, fresh=at == now)
            amount = f" {_amount(value, unit)}" if value is not None else ""
            if at.date() == now.date():
                example = f"Logged. That's **{_amount(info['today'], info['unit'])}** today."
                done = (f"Logged{' ' + entry if entry else ''}{amount} in '{info['name']}'. Today: "
                        f"{_amount(info['today'], info['unit'])} ({info['today_count']} entries); last 7 days: "
                        f"{_amount(info['week'], info['unit'])}; streak {info['streak']} day(s). It's on screen. Reply in "
                        f"one short sentence with these numbers, like: \"{example}\"")
            else:
                that_day = sum(r["value"] if r["value"] is not None else 1 for r in rows if r["time"].date() == at.date())
                done = (f"Logged{' ' + entry if entry else ''}{amount} for {at.strftime('%A %d %B')} in '{info['name']}' "
                        f"(that day: {_amount(that_day, info['unit'])}; last 7 days: {_amount(info['week'], info['unit'])}). "
                        "It's on screen. Reply in one short sentence.")
        elif action == "show":
            if not rows:
                return json.dumps({"success": False, "error": f"there's no '{name}' log yet"})
            info = summary(name, rows)
            done = (f"Showing '{info['name']}': today {_amount(info['today'], info['unit'])}, last 7 days "
                    f"{_amount(info['week'], info['unit'])}, {info['count']} entries in all.")
        elif action == "undo":
            if not rows:
                return json.dumps({"success": False, "error": f"there's no '{name}' log yet"})
            last = rows.pop()
            _write(name, rows)
            info = summary(name, rows)
            done = f"Removed the latest entry ({last['entry'] or _amount(last['value'] or 0, last['unit'])}). Today: {_amount(info['today'], info['unit'])}."
        else:
            return json.dumps({"success": False, "error": "action must be add, show, list or undo"})
    except OSError as exc:
        return json.dumps({"success": False, "error": f"couldn't use the log file: {exc}"})
    try:
        from .tools import _in_vyrse_session

        if _in_vyrse_session():
            _show(name, info)
    except Exception:
        pass  # the log itself is saved either way
    return json.dumps({"success": True, "result": done}, ensure_ascii=False)
