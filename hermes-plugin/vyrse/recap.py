"""The nightly recap ("how was my day?") and the PC doctor ("check up on my PC").

recap: screen time, gaming, the top apps, what was logged today, and tomorrow's reminders and alarms, as one card.
doctor: what's slowing the PC or worth fixing (startup apps, uptime, disk space, memory pressure, temperatures,
pending Windows updates), each with a plain fix VYRSE can do for the user after they say yes.
"""
from __future__ import annotations

import datetime as dt
import json
import subprocess
import time
from typing import Any, Dict, List


def _tomorrow_jobs() -> List[Dict[str, str]]:
    try:
        from tools.cronjob_tools import _cronjob_handler

        jobs = json.loads(_cronjob_handler({"action": "list"})).get("jobs") or []
    except Exception:
        return []
    start = dt.datetime.combine(dt.date.today() + dt.timedelta(days=1), dt.time())
    end = start + dt.timedelta(days=1)
    out = []
    for j in jobs:
        try:
            nxt = dt.datetime.fromisoformat(str(j.get("next_run_at"))).replace(tzinfo=None)
        except ValueError:
            continue
        if start <= nxt < end and j.get("enabled", True):
            out.append({"time": nxt.strftime("%H:%M"), "name": str(j.get("name") or "Reminder")[:60]})
    return sorted(out, key=lambda r: r["time"])


def _logs_today() -> List[str]:
    try:
        from . import log

        lines = []
        for f in sorted(log._dir().glob("*.csv")):
            info = log.summary(f.stem.replace("-", " "), log.read(f.stem))
            if info["today"]:
                amount = log._fmt(info["today"])
                lines.append(f"{info['name']}: {amount} {info['unit']}".strip())
        return lines[:4]
    except Exception:
        return []


def recap() -> Dict[str, Any]:
    from . import usage

    rep = usage.report("today")
    top = rep["top_apps"][:3]
    tomorrow = _tomorrow_jobs()
    logs = _logs_today()
    cards = [
        {"label": "Screen time", "value": rep["screen_time"], "detail": " · ".join(f"{a['app']} {a['time']}" for a in top) or "Nothing tracked yet", "icon": "clock"},
        {"label": "Gaming", "value": rep["gaming"], "detail": next((f"{a['app']} the most" for a in rep["top_apps"] if a["game"]), "No games today"), "icon": "game"},
        {"label": "Logged today", "detail": "\n".join(logs) or "Nothing logged", "icon": "study"},
        {"label": "Tomorrow", "detail": "\n".join(f"{j['time']} · {j['name']}" for j in tomorrow[:4]) or "Nothing scheduled", "icon": "calendar"},
    ]
    return {"ok": True, "screen_time": rep["screen_time"], "gaming": rep["gaming"], "top_apps": top, "logged_today": logs,
            "tomorrow": tomorrow, "card": {"kind": "cards", "id": "recap", "title": f"Your day · {dt.date.today().strftime('%A %d %B')}", "items": cards},
            "note": "The recap is on screen. Say it in two sentences in the user's style: one honest line about the day, and "
                    "tomorrow's first thing (if any). Offer to set an alarm if there's something early."}


_DOCTOR_PS = r"""
$ErrorActionPreference = 'SilentlyContinue'
$startup = @(Get-CimInstance Win32_StartupCommand | Select-Object -ExpandProperty Name)
$updates = $null
try {
  # Windows' own cached scan (Online=false): the same count in ~3 s instead of a ~30 s trip to Windows Update
  $q = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
  $q.Online = $false
  $updates = $q.Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates.Count
} catch {}
[pscustomobject]@{ startup = $startup; updates = $updates } | ConvertTo-Json -Compress
"""


def doctor() -> Dict[str, Any]:
    import psutil

    from .system import _disks, _gpu

    findings: List[Dict[str, str]] = []

    def add(level: str, what: str, fix: str) -> None:
        findings.append({"level": level, "what": what, "fix": fix})

    try:
        from hermes_cli._subprocess_compat import windows_hide_flags

        out = subprocess.run(["powershell.exe", "-NoProfile", "-Command", _DOCTOR_PS], capture_output=True, text=True, timeout=60,
                             creationflags=windows_hide_flags(), encoding="utf-8", errors="replace").stdout.strip().splitlines()
        extra = json.loads(out[-1]) if out else {}
    except Exception:
        extra = {}
    startup = list(dict.fromkeys(s for s in (extra.get("startup") or []) if s))
    if len(startup) > 8:
        add("warn", f"{len(startup)} apps start with Windows ({', '.join(startup[:5])}…)", "Turn off the ones you don't need at login (Task Manager → Startup apps); I can open it for you.")
    up_days = (time.time() - psutil.boot_time()) / 86400
    if up_days > 5:
        add("warn", f"No restart in {up_days:.0f} days", "A restart clears memory leaks and finishes pending updates.")
    for d in _disks():
        used = 100 * (1 - d["free_gb"] / max(d["total_gb"], 0.1))
        if used >= 90:
            add("bad", f"{d['drive']} is {used:.0f}% full ({d['free_gb']} GB free)", "Ask me what's eating the space, then clean the biggest folders.")
        elif used >= 80:
            add("warn", f"{d['drive']} is {used:.0f}% full", "Worth a clean-up soon; I can show what's using it.")
    mem = psutil.virtual_memory()
    if mem.percent >= 85:
        add("warn", f"Memory is {mem.percent:.0f}% used", "Close what you aren't using; I can show the biggest apps.")
    gpu = _gpu()
    if gpu and gpu.get("temperature_c", 0) >= 83:
        add("warn", f"GPU is at {gpu['temperature_c']:.0f}°C right now", "Check the fans and dust; keep it under ~80°C while gaming.")
    if isinstance(extra.get("updates"), int) and extra["updates"] > 0:
        add("warn", f"{extra['updates']} Windows update{'s' if extra['updates'] > 1 else ''} waiting", "Install them from Settings → Windows Update (I can open it).")
    if not findings:
        add("good", "Everything looks healthy", "Nothing to fix right now.")
    order = {"bad": 0, "warn": 1, "good": 2}
    findings.sort(key=lambda f: order[f["level"]])
    card = {"kind": "checklist", "id": "pc-doctor", "title": "PC check-up",
            "items": [{"label": f["what"], "note": f["fix"], "done": f["level"] == "good"} for f in findings]}
    return {"ok": True, "findings": findings, "card": card,
            "note": "The check-up is on screen. Say the most important finding in a sentence and offer to fix it; "
                    "only change anything after the user says yes."}
