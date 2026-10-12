"""Reminders and routines for VYRSE, built on Hermes' own cron (the `cronjob` tool and jobs store).

- `start()`: runs Hermes' scheduler inside the VYRSE backend, the same ticker Hermes Desktop uses, so
  jobs fire while VYRSE is open. It defers to a running Hermes gateway and takes Hermes' tick lock.
- `fired_since()`: the results of jobs that ran since a time, read from Hermes' run documents
  (cron/output/<job>/<time>.md), which VYRSE shows and speaks.
"""
from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Dict, List

logger = logging.getLogger(__name__)
_started = False
_stop = threading.Event()

_TITLE_RE = re.compile(r"^# Cron Job: (.+)$", re.M)
_RESPONSE_RE = re.compile(r"\*\*Response Characters:\*\* (\d+)\n## Response\n\n")
_STATUS_RE = re.compile(r"^\*\*Status:\*\* (\w+)", re.M)


def start() -> None:
    """Only in the backend VYRSE spawned (it sets the session token); never in CLI processes."""
    global _started
    if _started or not os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN"):
        return
    _started = True

    def run() -> None:
        try:
            from hermes_cli.web_server import _start_desktop_cron_ticker

            _start_desktop_cron_ticker(_stop)
        except Exception:
            logger.exception("vyrse: reminder scheduler stopped")

    threading.Thread(target=run, daemon=True, name="vyrse-cron-ticker").start()


def _output_dir() -> Path:
    from cron.jobs import get_cron_output_dir

    return Path(get_cron_output_dir())


def parse_run(text: str) -> Dict[str, Any]:
    title = _TITLE_RE.search(text)
    match = None
    for match in _RESPONSE_RE.finditer(text):
        pass
    if match is not None:
        body = text[match.end():match.end() + int(match.group(1))]
    elif "## Response\n\n" in text:
        body = text.rsplit("## Response\n\n", 1)[1]
    else:
        body = ""
    status = _STATUS_RE.search(text)
    return {
        "name": title.group(1).strip() if title else "Reminder",
        "text": body.strip(),
        "ok": not (status and status.group(1).upper() in ("BLOCKED", "FAILED", "ERROR")) and bool(body.strip()),
    }


def fired_since(since: float, limit: int = 10) -> List[Dict[str, Any]]:
    """Runs whose document was written after `since` (unix seconds), oldest first."""
    root = _output_dir()
    if not root.is_dir():
        return []
    runs = []
    for doc in root.glob("*/*.md"):
        try:
            mtime = doc.stat().st_mtime
        except OSError:
            continue
        if mtime > since:
            runs.append((mtime, doc))
    out = []
    for mtime, doc in sorted(runs)[-limit:]:
        try:
            parsed = parse_run(doc.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        out.append({"job_id": doc.parent.name, "at": mtime, **parsed})
    return out


# --- the vyrse_reminders tool -------------------------------------------------------------------------
# Hermes only offers its `cronjob_manage` tool to CLI, gateway and cron sessions (check_fn), not to `serve`
# clients. Enabling it by setting HERMES_INTERACTIVE would also change approval routing, so VYRSE instead
# exposes the same implementation, with a slimmer schema for small local models, in VYRSE sessions only.
# Same job store, same scheduler, same validation; delivery is fixed to "local" (VYRSE shows the result).

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_reminders",
    "description": (
        "Reminders and routines. action=create schedules one (needs schedule and prompt); list shows them "
        "(always list before changing one, never guess ids); pause/resume/remove/run take job_id. When it fires, "
        "VYRSE shows and says the result, so write `prompt` as the instruction for what to tell the user, e.g. "
        "'Remind the user to drink some water.' or 'Tell the user today's weather in Berlin in two sentences.' "
        "alarm=true makes it an ALARM that rings in VYRSE until the user stops it ('set an alarm for 8:30', 'wake me at "
        "7'); for an alarm, schedule may be just the clock time ('8:30', '7am') and prompt can be omitted."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["create", "list", "update", "pause", "resume", "remove", "run"]},
            "schedule": {
                "type": "string",
                "description": (
                    "For create/update. One-shot: 'in 10m', 'in 2h' (use this for 'remind me in N minutes'; never "
                    "compute timestamps yourself) or an ISO time '2026-06-01T18:00:00'. Recurring: 'every 2h', "
                    "'every day at 8am', 'weekdays at 9am', 'every monday 9am', or cron '0 9 * * *'."
                ),
            },
            "prompt": {"type": "string", "description": "For create/update: what to do or say when it fires."},
            "name": {"type": "string", "description": "Short label shown to the user, e.g. 'Drink water'."},
            "job_id": {"type": "string", "description": "For update/pause/resume/remove/run (from list)."},
            "repeat": {"type": "integer", "description": "Optional number of times to run; omit for the default."},
            "alarm": {"type": "boolean", "description": "For create: ring like an alarm when it fires."},
        },
        "required": ["action"],
    },
}


_FRAME = (
    "You are VYRSE, the user's assistant, delivering a scheduled reminder or routine. Your reply is shown and "
    "read aloud to the user as it is: address them directly, warmly and briefly (one to three sentences), and "
    "do any lookups the task needs first. Task: "
)


def _clock(text: str):
    """'8:30', '8:30am', '7 pm', '07:15' -> the next time the clock shows it (local), else None."""
    import datetime as dt
    import re

    m = re.fullmatch(r"\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*", text.lower())
    if not m:
        return None
    hour, minute, half = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").replace(".", "")
    if half == "pm" and hour < 12:
        hour += 12
    if half == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return None
    now = dt.datetime.now()
    at = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return at if at > now else at + dt.timedelta(days=1)


def _alarm_card(at) -> None:
    from .workspace import build_artifact, deliver

    label = at.strftime("%I:%M %p").lstrip("0")
    try:
        art = build_artifact({"kind": "timer", "id": f"alarm-{at.strftime('%H%M')}", "title": f"Alarm · {label}",
                              "until": at.strftime("%Y-%m-%dT%H:%M"), "caption": "Rings in VYRSE until you stop it"})
        deliver({"action": "workspace", "op": "show", "artifact": art})
    except Exception:
        pass


def handle(params: Dict[str, Any], **kw: Any) -> str:
    import json

    from tools.cronjob_tools import _cronjob_handler

    from .tools import _in_vyrse_session

    if not _in_vyrse_session():
        return json.dumps({"success": False, "error": "vyrse_reminders only works in the VYRSE desktop app."})
    args = {k: params[k] for k in ("action", "schedule", "prompt", "name", "job_id", "repeat") if params.get(k) not in (None, "")}
    alarm_at = None
    if args.get("action") == "create" and params.get("alarm") is True:
        alarm_at = _clock(str(args.get("schedule") or ""))
        if alarm_at is not None:
            args["schedule"] = alarm_at.strftime("%Y-%m-%dT%H:%M:00")
        when = alarm_at.strftime("%I:%M %p").lstrip("0") if alarm_at is not None else str(args.get("schedule") or "")
        # The app rings anything named "Alarm · …" until the user stops it.
        args["name"] = f"Alarm · {when}" if not str(args.get("name") or "").startswith("Alarm") else args["name"]
        args.setdefault("prompt", f"It's {when}: the user's alarm. Wake them up in one short, warm sentence (mention anything "
                                  "they said it was for).")
    if args.get("action") in ("create", "update"):
        args["deliver"] = "local"
        if args.get("prompt") and not str(args["prompt"]).startswith(_FRAME):
            # The job runs as a fresh agent with no chat context; without this it answers the reminder
            # itself ("I can't drink water") instead of writing the message for the user.
            args["prompt"] = f"{_FRAME}{args['prompt']}"
    try:
        out = _cronjob_handler(args, **kw)
        if alarm_at is not None:
            try:
                ok = json.loads(out).get("success") is True
            except (ValueError, AttributeError):
                ok = False
            if ok:
                _alarm_card(alarm_at)
        return out
    except Exception as exc:
        return json.dumps({"success": False, "error": f"Couldn't update reminders: {exc}"})
