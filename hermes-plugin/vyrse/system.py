"""`vyrse_system`: accurate PC stats in one call (psutil + nvidia-smi), optionally shown in the workspace.

Small local models improvise poorly here (Linux `ps`/`df` in Git Bash gave wrong numbers), so the common
questions — CPU, memory, GPU, disks, network, top processes, usage over time — have a direct answer.
"""
from __future__ import annotations

import json
from datetime import date as _date
import logging
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_system",
    "description": (
        "Accurate stats about this PC. Use it instead of terminal commands for CPU, memory, GPU, disks, network "
        "and running processes. action=overview (everything at a glance); action=processes (top apps by memory "
        "or cpu); action=disks; action=storage (what's eating disk space: the biggest folders, measured; `path` "
        "to look inside one, e.g. 'C:\\Users\\you\\AppData\\Local'); action=sample (metric cpu|memory|gpu|network measured every `interval` seconds "
        "for `seconds`, e.g. 'graph my CPU for 10 s'); action=watch (a LIVE chart of metric in the workspace that "
        "keeps updating every `interval` seconds for `minutes`, e.g. 'keep an eye on my GPU while I game'; it runs "
        "in the background, so reply right away; with alert_above/alert_below it also ALERTS once the value crosses "
        "that line: VYRSE says it aloud and, with notify_phone=true, pings the user's phone, e.g. 'ping my phone if my "
        "GPU goes over 80 degrees' = watch gpu_temp alert_above 80 notify_phone true minutes 120); "
        "action=stop_watch (metric); action=usage (screen time: which apps and games, how long, today or period=week, "
        "and the gaming stretch going on right now: 'how long have I been gaming today?'); action=games (installed "
        "Steam games); action=rewind (a timeline of what was on screen: 'what was I doing before lunch', 'what did I have open "
        "yesterday'; then you can reopen things with vyrse_files/vyrse_desktop); action=recap (the nightly recap: 'how was my "
        "day', 'recap my day'); action=doctor (a PC check-up: what's slowing it or worth fixing, with fixes to offer). "
        "show=true also puts the result in "
        "VYRSE's workspace (chart, bar chart or table), so you only need to say a sentence about it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["overview", "processes", "disks", "storage", "sample", "watch", "stop_watch", "usage", "games", "rewind", "recap", "doctor"]},
            "hours": {"type": "number", "description": "For rewind: how far back from now (default 3), or with day=yesterday the whole day."},
            "day": {"type": "string", "enum": ["today", "yesterday"], "description": "For rewind: a whole day instead of the last hours."},
            "date": {"type": "string", "description": f"For usage or rewind: one specific day, YYYY-MM-DD. It is {_date.today().year} now: "
                                                      "'on October 15' -> that date this year."},
            "part": {"type": "string", "enum": ["morning", "afternoon", "evening", "night"],
                     "description": "For rewind: part of the day ('yesterday afternoon' -> day=yesterday, part=afternoon)."},
            "at": {"type": "string", "description": "For rewind: a clock time, 24h HH:MM ('what was I doing at 3' -> 15:00; at 3 in the "
                                                    "morning -> 03:00). Shows the hour around it, on `date` or today."},
            "period": {"type": "string", "enum": ["today", "week"], "description": "For usage. Default today."},
            "metric": {"type": "string", "enum": ["cpu", "memory", "gpu", "gpu_temp", "network"],
                       "description": "For sample/watch/stop_watch."},
            "minutes": {"type": "number", "description": "For watch: how long to keep updating, 1-30 (up to 240 with an alert). Default 5 (60 with an alert)."},
            "alert_above": {"type": "number", "description": "For watch: alert when the value goes above this."},
            "alert_below": {"type": "number", "description": "For watch: alert when the value drops below this."},
            "notify_phone": {"type": "boolean", "description": "For watch alerts: also ping the user's phone."},
            "seconds": {"type": "number", "description": "For sample: total time, 1-60. Default 10."},
            "interval": {"type": "number", "description": "For sample/watch: seconds between readings. Default 1 (sample), 2 (watch)."},
            "sort": {"type": "string", "enum": ["memory", "cpu"], "description": "For processes. Default memory."},
            "limit": {"type": "integer", "description": "For processes: how many, 1-25. Default 8."},
            "show": {"type": "boolean", "description": "Also show the result in the workspace."},
            "path": {"type": "string", "description": "For storage: a folder to look inside (default: your profile and the system drive)."},
        },
        "required": ["action"],
    },
}


def _num_or_none(value: Any) -> Optional[float]:
    try:
        return None if value in (None, "") else float(value)
    except (TypeError, ValueError):
        return None


def _gb(n: float) -> float:
    return round(n / 1024 ** 3, 1)


def _gpu() -> Optional[Dict[str, Any]]:
    try:
        from hermes_cli._subprocess_compat import windows_hide_flags

        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, creationflags=windows_hide_flags(),
        ).stdout.strip().splitlines()
        name, util, used, total, temp = [x.strip() for x in out[0].split(",")]
        return {"name": name, "usage_percent": float(util), "vram_used_gb": round(float(used) / 1024, 1),
                "vram_total_gb": round(float(total) / 1024, 1), "temperature_c": float(temp)}
    except Exception:
        return None


def _disks() -> List[Dict[str, Any]]:
    import psutil

    rows = []
    for part in psutil.disk_partitions(all=False):
        if "cdrom" in part.opts or not part.fstype:
            continue
        try:
            u = psutil.disk_usage(part.mountpoint)
        except OSError:
            continue
        rows.append({"drive": part.mountpoint.rstrip("\\"), "total_gb": _gb(u.total), "free_gb": _gb(u.free),
                     "used_percent": round(u.percent, 1)})
    return rows


def _reparse(st: Any) -> bool:
    """Junctions and other reparse points ("Local Settings" -> AppData/Local): skipped, or space counts twice."""
    return bool(getattr(st, "st_file_attributes", 0) & 0x400)


def _folder_size(path: str, deadline: float) -> Tuple[int, bool]:
    """Bytes under `path` (no following links), and whether it finished before the deadline."""
    import os

    total, stack = 0, [path]
    while stack:
        if time.monotonic() > deadline:
            return total, False
        try:
            with os.scandir(stack.pop()) as it:
                for e in it:
                    try:
                        if e.is_symlink() or _reparse(e.stat(follow_symlinks=False)):
                            continue
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                        else:
                            total += e.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total, True


def _storage(path: str = "", budget_s: float = 25.0) -> Dict[str, Any]:
    """The biggest folders, measured in parallel within a time budget (a full drive scan takes minutes)."""
    import os
    from concurrent.futures import ThreadPoolExecutor

    if path:
        root = os.path.expandvars(os.path.expanduser(path.strip().strip('"')))
        if not os.path.isdir(root):
            raise ValueError(f"no folder at {path}")
        tops = [os.path.join(root, n) for n in os.listdir(root)]
    else:
        home = os.path.expanduser("~")
        system = os.environ.get("SystemDrive", "C:") + "\\"
        skip = {os.path.normcase(home), os.path.normcase(os.path.join(system, "Users"))}
        tops = [os.path.join(home, n) for n in os.listdir(home)]
        tops += [os.path.join(home, "AppData", n) for n in ("Local", "Roaming", "LocalLow") if os.path.isdir(os.path.join(home, "AppData", n))]
        tops = [t for t in tops if os.path.normcase(t) != os.path.normcase(os.path.join(home, "AppData"))]
        tops += [t for t in (os.path.join(system, n) for n in os.listdir(system)) if os.path.normcase(t) not in skip]
    tops = [t for t in tops if os.path.isdir(t) and not os.path.islink(t) and not _reparse(os.lstat(t))]
    deadline = time.monotonic() + budget_s
    with ThreadPoolExecutor(max_workers=8) as pool:
        sizes = list(pool.map(lambda t: (t, *_folder_size(t, deadline)), tops))
    rows = sorted(({"folder": t, "gb": round(b / 2**30, 2), "complete": done} for t, b, done in sizes if b > 0),
                  key=lambda r: -r["gb"])
    return {"root": path or "your profile and the system drive", "folders": rows[:25],
            "partial": any(not r["complete"] for r in rows[:25])}


def _processes(sort: str, limit: int) -> List[Dict[str, Any]]:
    import psutil

    procs = list(psutil.process_iter(["pid", "name", "memory_info"]))
    if sort == "cpu":
        for p in procs:
            try:
                p.cpu_percent(None)
            except psutil.Error:
                pass
        time.sleep(0.8)
    # Group by name: Chrome/Edge run as dozens of processes; users think in apps.
    apps: Dict[str, Dict[str, Any]] = {}
    for p in procs:
        try:
            name = (p.info.get("name") or "?").removesuffix(".exe")
            if name in ("System Idle Process", "Idle"):
                continue
            mem = (p.info.get("memory_info").rss if p.info.get("memory_info") else 0)
            cpu = p.cpu_percent(None) / psutil.cpu_count() if sort == "cpu" else 0.0
        except psutil.Error:
            continue
        app = apps.setdefault(name, {"name": name, "memory_mb": 0.0, "cpu_percent": 0.0, "processes": 0})
        app["memory_mb"] += mem / 1024 ** 2
        app["cpu_percent"] += cpu
        app["processes"] += 1
    key = "cpu_percent" if sort == "cpu" else "memory_mb"
    top = sorted(apps.values(), key=lambda a: a[key], reverse=True)[:limit]
    for a in top:
        a["memory_mb"] = round(a["memory_mb"], 0)
        a["cpu_percent"] = round(a["cpu_percent"], 1)
    return top


def _read(metric: str, last_net: List[Any]) -> float:
    import psutil

    if metric == "cpu":
        return psutil.cpu_percent(None)
    if metric == "memory":
        return psutil.virtual_memory().percent
    if metric in ("gpu", "gpu_temp"):
        g = _gpu()
        return (g["temperature_c"] if metric == "gpu_temp" else g["usage_percent"]) if g else 0.0
    counters = psutil.net_io_counters()
    now = time.monotonic()
    total = counters.bytes_recv + counters.bytes_sent
    prev = last_net[0] if last_net else None
    last_net[:] = [(now, total)]
    if not prev:
        return 0.0
    return round((total - prev[1]) / max(1e-3, now - prev[0]) / 1024 ** 2, 2)  # MB/s


_NAMES = {"cpu": "CPU usage", "memory": "Memory usage", "gpu": "GPU usage", "gpu_temp": "GPU temperature",
          "network": "Network traffic"}
_UNITS = {"cpu": "%", "memory": "%", "gpu": "%", "gpu_temp": "°C", "network": " MB/s"}
_WINDOW = 60  # points kept on a live chart
_watches: Dict[tuple, Any] = {}
_watch_lock = threading.Lock()


def stop(session_id: str, item_id: str) -> bool:
    """Stop a live chart (also called when the user removes it from the workspace)."""
    with _watch_lock:
        event = _watches.pop((session_id, item_id), None)
    if event is not None:
        event.set()
    return event is not None


def stop_all(session_id: str) -> None:
    with _watch_lock:
        keys = [k for k in _watches if k[0] == session_id]
    for key in keys:
        stop(*key)


def _alert(metric: str, value: float, line: float, above: bool, phone: bool) -> None:
    """Said aloud in VYRSE (with the alert sound) and, if asked, pushed to the phone."""
    from tools import desktop_ui

    unit = _UNITS[metric].strip()
    what = {"gpu_temp": "GPU", "gpu": "GPU usage", "cpu": "CPU", "memory": "Memory", "network": "Network"}[metric]
    shown = f"{value:g}{'°' if metric == 'gpu_temp' else (' ' + unit if unit.startswith('MB') else unit)}"
    text = f"Heads up! {what} just hit {shown}." if above else f"Heads up! {what} dropped to {shown}."
    desktop_ui.emit("vyrse.ui", {"action": "alert", "title": f"{_NAMES[metric]} {'over' if above else 'under'} {line:g}", "text": text})
    if phone:
        from . import desktop_call

        try:
            desktop_call.call("phone", "notify", {"title": "VYRSE", "text": text}, timeout=15.0)
        except Exception:
            logger.warning("vyrse: phone alert not delivered", exc_info=True)


def _watch(metric: str, interval: float, minutes: float, above: Optional[float] = None, below: Optional[float] = None,
           phone: bool = False) -> Dict[str, Any]:
    import contextvars

    from gateway.session_context import get_session_env

    from .workspace import build_artifact, deliver

    session_id = get_session_env("HERMES_SESSION_ID", "") or "default"
    item_id = f"live-{metric}"
    stop(session_id, item_id)  # one live chart per metric
    halt = threading.Event()
    with _watch_lock:
        _watches[(session_id, item_id)] = halt
    ends_at = time.time() + minutes * 60
    until = time.strftime("%H:%M", time.localtime(ends_at))

    def run() -> None:
        import psutil

        last_net: List[Any] = []
        points: List[Dict[str, Any]] = []
        armed = [True, True]
        if metric == "cpu":
            psutil.cpu_percent(None)
        if metric == "network":
            _read("network", last_net)
        try:
            while not halt.wait(interval) and time.time() < ends_at:
                points.append({"label": time.strftime("%H:%M:%S"), "value": round(_read(metric, last_net), 1)})
                points[:] = points[-_WINDOW:]
                values = [p["value"] for p in points]
                now = values[-1]
                # Once per crossing: it re-arms after the value comes back past the line by a margin.
                if above is not None:
                    if armed[0] and now > above:
                        armed[0] = False
                        _alert(metric, now, above, True, phone)
                    elif now < above - 3:
                        armed[0] = True
                if below is not None:
                    if armed[1] and now < below:
                        armed[1] = False
                        _alert(metric, now, below, False, phone)
                    elif now > below + 3:
                        armed[1] = True
                art = build_artifact({
                    "kind": "chart", "id": item_id, "title": f"{_NAMES[metric]} · live", "unit": _UNITS[metric],
                    "points": points, **({"threshold": above if above is not None else below} if (above is not None or below is not None) else {}),
                    "caption": f"now {values[-1]} · max {max(values)} · updates every {interval:g} s until {until}",
                })
                deliver({"action": "workspace", "op": "show", "artifact": art}, persist=False)
            if points and not halt.is_set():
                values = [p["value"] for p in points]
                art = build_artifact({
                    "kind": "chart", "id": item_id, "title": f"{_NAMES[metric]} (ended {time.strftime('%H:%M')})",
                    "unit": _UNITS[metric], "points": points,
                    "caption": f"min {min(values)} · avg {round(sum(values) / len(values), 1)} · max {max(values)}",
                })
                deliver({"action": "workspace", "op": "show", "artifact": art})
        except Exception:
            logger.exception("vyrse: live %s chart stopped", metric)
        finally:
            with _watch_lock:
                if _watches.get((session_id, item_id)) is halt:
                    _watches.pop((session_id, item_id), None)

    # The copied context carries the conversation/window this tool call belongs to.
    ctx = contextvars.copy_context()
    threading.Thread(target=ctx.run, args=(run,), daemon=True, name=f"vyrse-live-{metric}").start()
    out: Dict[str, Any] = {"watching": metric, "until": until, "every_seconds": interval,
                           "note": "Live chart started in the workspace; it updates by itself. Reply now."}
    if above is not None or below is not None:
        out["alert"] = (f"above {above:g}" if above is not None else f"below {below:g}") + (" (and the phone)" if phone else "")
        out["note"] = "Watching in the background; VYRSE will speak up" + (" and ping the phone" if phone else "") +             " if it crosses the line. Reply now, briefly (e.g. 'On it. Go play.')."
    return out


_PARTS = {"morning": (5, 12), "afternoon": (12, 17), "evening": (17, 21), "night": (21, 29)}


def _date_param(value: Any) -> Optional["date"]:
    import datetime as _dt

    try:
        d = _dt.date.fromisoformat(str(value).strip()[:10]) if value else None
    except ValueError:
        return None
    # Models fill in the year they were trained in ("2024-10-15"). Nothing can be recorded before VYRSE started
    # tracking, so a year like that means this year's same day (when that isn't in the future).
    if d is not None and d.year != _dt.date.today().year:
        from . import usage

        first = usage.tracked_since()
        try:
            this_year = d.replace(year=_dt.date.today().year)
        except ValueError:
            return d
        if (first is None or d < first) and this_year <= _dt.date.today():
            return this_year
    return d


def _clock_param(value: Any) -> Optional["dtime"]:
    import datetime as _dt
    import re as _re

    m = _re.fullmatch(r"\s*(\d{1,2})(?::(\d{2}))?\s*", str(value or ""))
    if not m or int(m.group(1)) > 23 or int(m.group(2) or 0) > 59:
        return None
    return _dt.time(int(m.group(1)), int(m.group(2) or 0))


def _show(artifact_params: Dict[str, Any]) -> Optional[str]:
    from .workspace import build_artifact, deliver

    artifact = build_artifact(artifact_params)
    if not deliver({"action": "workspace", "op": "show", "artifact": artifact}):
        return "the VYRSE window isn't connected, so nothing was shown"
    return (f"shown in the workspace as '{artifact['title']}'. The user can see the numbers: reply in a sentence or "
            "two with only what matters (the busiest part, anything near its limit), not a list of every number")


def handle(params: Dict[str, Any], **_: Any) -> str:
    import psutil

    action = params.get("action")
    # In VYRSE the answer to "how's my PC" / "what's eating my storage" is a picture: draw it unless told not to.
    show = params.get("show") is not False if action in ("overview", "storage", "processes", "usage") else bool(params.get("show"))
    result: Dict[str, Any] = {"success": True}
    try:
        if action == "overview":
            psutil.cpu_percent(None)
            time.sleep(0.5)
            mem = psutil.virtual_memory()
            result.update(
                cpu_percent=psutil.cpu_percent(None), cpu_cores=psutil.cpu_count(),
                memory={"used_gb": _gb(mem.used), "total_gb": _gb(mem.total), "percent": mem.percent},
                gpu=_gpu(), disks=_disks(),
                uptime_hours=round((time.time() - psutil.boot_time()) / 3600, 1),
            )
            battery = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None
            if battery:
                result["battery"] = {"percent": battery.percent, "plugged_in": battery.power_plugged}
            if show:
                # Gauges, each turning hot past the level worth a mention.
                items = [{"label": "CPU", "value": result["cpu_percent"], "max": 100, "unit": "%", "warn": 90},
                         {"label": "RAM", "value": mem.percent, "max": 100, "unit": "%", "warn": 90}]
                if result["gpu"]:
                    g = result["gpu"]
                    items.append({"label": "GPU", "value": round(g["temperature_c"]), "max": 100, "unit": "°C", "warn": 83})
                    items.append({"label": "VRAM", "value": round(100 * g["vram_used_gb"] / max(g["vram_total_gb"], 0.1)), "max": 100, "unit": "%", "warn": 95})
                items += [{"label": f"Disk {d['drive'].rstrip(chr(92)).rstrip(':')}", "value": round(100 * (1 - d["free_gb"] / max(d["total_gb"], 0.1))),
                           "max": 100, "unit": "%", "warn": 90} for d in result["disks"][:2]]
                result["workspace"] = _show({"kind": "gauges", "id": "pc-overview", "title": "Your PC right now", "items": items[:6],
                                             "caption": f"Up for {result['uptime_hours']} h"})
        elif action == "disks":
            result["disks"] = _disks()
            if show:
                result["workspace"] = _show({
                    "kind": "table", "id": "disks", "title": "Drives",
                    "columns": ["Drive", "Free (GB)", "Total (GB)", "Used"],
                    "rows": [[d["drive"], d["free_gb"], d["total_gb"], f"{d['used_percent']}%"] for d in result["disks"]],
                })
        elif action == "storage":
            import os

            data = _storage(str(params.get("path") or ""))
            result.update(storage=data, disks=_disks())
            if data["partial"]:
                result["note"] = "Some folders were still being measured when time ran out: their sizes (marked '+') are at least that big."
            if show and data["folders"]:
                top = data["folders"][:12]
                label = lambda r: (os.path.basename(r["folder"].rstrip("\\/")) or r["folder"])[:22] + ("" if r["complete"] else "+")  # noqa: E731
                _show({"kind": "table", "id": "storage-table", "title": "Biggest folders",
                       "columns": ["Folder", "Size (GB)", "Where"],
                       "rows": [[label(r), r["gb"], r["folder"]] for r in top], "highlight": label(top[0])})
                result["note_for_reply"] = ("The donut and the table are already on screen: don't call vyrse_workspace "
                                            "for them. Reply in a sentence or two: the biggest folder and what to do.")
                result["workspace"] = _show({"kind": "chart", "style": "donut", "id": "storage", "title": "What's using your space",
                                             "unit": " GB", "points": [{"label": label(r), "value": r["gb"]} for r in top[:8]],
                                             "caption": "; ".join(f"{d['drive']} {d['free_gb']} GB free of {d['total_gb']} GB" for d in result["disks"])})
        elif action == "processes":
            sort = "cpu" if params.get("sort") == "cpu" else "memory"
            limit = max(1, min(25, int(params.get("limit") or 8)))
            top = _processes(sort, limit)
            result["processes"] = top
            if show:
                metric = "cpu_percent" if sort == "cpu" else "memory_mb"
                result["workspace"] = _show({
                    "kind": "chart", "style": "bar", "id": f"top-{sort}",
                    "title": f"Top apps by {'CPU' if sort == 'cpu' else 'memory'}",
                    "unit": "%" if sort == "cpu" else " MB",
                    "points": [{"label": a["name"], "value": a[metric]} for a in top],
                })
        elif action == "sample":
            metric = params.get("metric") if params.get("metric") in _NAMES else "cpu"
            seconds = max(1.0, min(60.0, float(params.get("seconds") or 10)))
            interval = max(0.5, min(10.0, float(params.get("interval") or 1)))
            last_net: List[Any] = []
            if metric == "cpu":
                psutil.cpu_percent(None)
            if metric == "network":
                _read("network", last_net)
            points = []
            start = time.monotonic()
            for i in range(max(1, round(seconds / interval))):
                time.sleep(max(0.0, start + (i + 1) * interval - time.monotonic()))
                points.append({"label": f"{(i + 1) * interval:g}s", "value": round(_read(metric, last_net), 1)})
            unit = _UNITS[metric].strip()
            values = [p["value"] for p in points]
            result.update(metric=metric, unit=unit, points=points,
                          summary={"min": min(values), "max": max(values), "avg": round(sum(values) / len(values), 1)})
            if show:
                result["workspace"] = _show({
                    "kind": "chart", "id": f"sample-{metric}", "title": f"{_NAMES[metric]} ({seconds:g} s)",
                    "unit": _UNITS[metric], "points": points,
                    "caption": f"min {min(values)} · avg {result['summary']['avg']} · max {max(values)}",
                })
        elif action == "watch":
            metric = params.get("metric") if params.get("metric") in _NAMES else "cpu"
            interval = max(1.0, min(10.0, float(params.get("interval") or 2)))
            above, below = _num_or_none(params.get("alert_above")), _num_or_none(params.get("alert_below"))
            alerting = above is not None or below is not None
            minutes = max(1.0, min(240.0 if alerting else 30.0, float(params.get("minutes") or (60 if alerting else 5))))
            result.update(_watch(metric, interval, minutes, above, below, params.get("notify_phone") is True))
        elif action == "usage":
            from . import usage

            period = "week" if params.get("period") == "week" else "today"
            on = _date_param(params.get("date"))
            rep = usage.report(period, on)
            result.update(rep)
            if not rep["top_apps"]:
                since = rep.get("tracked_since")
                result["note"] = (f"Nothing recorded for that {'day' if period != 'week' or on else 'week'}. VYRSE has tracked screen time "
                                  f"since {since} (only while it runs). Say exactly that; don't guess other reasons." if since else
                                  "VYRSE hasn't recorded any screen time yet (it counts while it runs).")
            if show and rep["top_apps"]:
                label = "today" if on is None else on.strftime("%b %d").replace(" 0", " ")
                top = rep["top_apps"][:8]
                # a small dashboard: the totals, then the picture
                result["workspace"] = _show({"kind": "stats", "id": "screen-time-stats", "title": f"Screen time · {'this week' if period == 'week' and on is None else label}",
                                             "items": [{"label": "Screen time", "value": rep["screen_time"]},
                                                       {"label": "Gaming", "value": rep["gaming"]},
                                                       {"label": "Top app", "value": top[0]["app"], "note": top[0]["time"]}]})
                if period == "week" and on is None:
                    _show({"kind": "chart", "style": "bar", "id": "screen-time-week", "title": "Screen time per day",
                           "unit": " min", "points": [{"label": d["day"], "value": d["total_min"]} for d in rep["days"]],
                           "caption": f"{rep['screen_time']} this week · {rep['gaming']} of it gaming"})
                else:
                    _show({"kind": "chart", "style": "bar", "id": "screen-time", "title": f"Apps · {label}",
                           "unit": " min", "points": [{"label": a["app"], "value": a["minutes"]} for a in top],
                           "highlight": next((a["app"] for a in top if a["game"]), ""),
                           "caption": f"{rep['gaming']} gaming · {rep['screen_time']} in total"})
        elif action in ("recap", "doctor"):
            from . import recap

            rep = recap.recap() if action == "recap" else recap.doctor()
            card = rep.pop("card")
            result.update(rep)
            result["workspace"] = _show(card)
        elif action == "rewind":
            import datetime as _dt

            from . import usage

            on = _date_param(params.get("date"))
            at = _clock_param(params.get("at"))
            if at is not None:
                d = on or _dt.date.today()
                moment = _dt.datetime.combine(d, at)
                if on is None and moment > _dt.datetime.now():  # "at 3" said in the morning means yesterday's 3
                    moment -= _dt.timedelta(days=1)
                start = moment.timestamp() - 3600
                end = moment.timestamp() + 3600
            elif on is not None or params.get("day") in ("today", "yesterday") or params.get("part") in _PARTS:
                d = on or (_dt.date.today() - _dt.timedelta(days=1 if params.get("day") == "yesterday" else 0))
                start = time.mktime(d.timetuple())
                end = start + 86400
                if params.get("part") in _PARTS:
                    a, b = _PARTS[params["part"]]
                    start, end = start + a * 3600, start + b * 3600
            else:
                end = time.time()
                start = end - max(0.25, min(48.0, float(params.get("hours") or 3))) * 3600
            rows = usage.rewind(start, end)
            result.update(timeline=rows[-60:], note="From VYRSE's on-device screen timeline (only while VYRSE runs; private mode isn't recorded).")
            if rows:
                result["workspace"] = _show({"kind": "timeline", "id": "rewind", "title": "Rewind",
                                             "items": [{"at": f"{r['from']}-{r['to']}", "label": r["what"], "detail": f"{r['app']} · {r['minutes']} min"} for r in rows[-24:]]})
        elif action == "games":
            from . import usage

            names = usage.installed_games()
            result.update(installed=len(names), games=names[:60],
                          note="Installed Steam games on this PC (owned-but-not-installed ones aren't visible offline).")
        elif action == "stop_watch":
            from gateway.session_context import get_session_env

            session_id = get_session_env("HERMES_SESSION_ID", "") or "default"
            metric = params.get("metric")
            if metric in _NAMES:
                result["stopped"] = stop(session_id, f"live-{metric}")
            else:
                stop_all(session_id)
                result["stopped"] = "all"
        else:
            return json.dumps({"success": False, "error": "action must be overview, processes, disks, sample, watch or stop_watch"})
    except Exception as exc:
        return json.dumps({"success": False, "error": f"Couldn't read system stats: {exc}"})
    return json.dumps(result, ensure_ascii=False)
