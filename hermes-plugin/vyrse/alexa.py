"""`vyrse_alexa`: VYRSE -> Amazon Echo.

- command: any Alexa request as text, run on the Echo exactly as if spoken to it ("turn off the lights",
  "play lofi on Spotify"). Uses the user's Amazon sign-in held by the VYRSE desktop app (alexa-remote2).
- say: the Echo says something. Voice Monkey (official Alexa skill) when set up, else the sign-in.
- routine: run an Alexa routine. Voice Monkey trigger devices by name, else asked as a text command.
- devices: what is connected.

Purchases need the user's OK first (ask-first rule); private mode blocks the tool (privacy.py).
The Voice Monkey token stays in %HERMES_HOME%/vyrse/voicemonkey.json and is never sent to the UI.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

VOICEMONKEY_API = "https://api-v3.voicemonkey.io"
_BUYING = re.compile(r"\b(buy|order|purchase|re-?order|pay|checkout|add .* to (my )?cart)\b", re.IGNORECASE)

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_alexa",
    "description": (
        "Control the user's Amazon Echo / Alexa. action=command runs any Alexa request as text on the Echo, "
        "exactly as if the user said it to Alexa (smart home, music, timers, Alexa skills): text is the request "
        "WITHOUT the word 'Alexa', e.g. 'turn off the bedroom lights'. action=say makes the Echo speak text out "
        "loud. action=routine runs an Alexa routine by name. action=devices lists Echo devices. device = Echo "
        "name (optional, defaults to the main one)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["command", "say", "routine", "devices"]},
            "text": {"type": "string", "description": "command: the Alexa request; say: what the Echo should say"},
            "name": {"type": "string", "description": "routine: the routine's name"},
            "device": {"type": "string", "description": "Echo device name (optional)"},
        },
        "required": ["action"],
    },
}


def _config_path() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes") / "vyrse" / "voicemonkey.json"


def load_voicemonkey() -> Dict[str, Any]:
    try:
        data = json.loads(_config_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_voicemonkey(token: Optional[str], speaker: Optional[str], routines: Optional[Dict[str, str]]) -> Dict[str, Any]:
    """Update the Voice Monkey setup; an empty token removes it. Returns the public view (no token)."""
    data = load_voicemonkey()
    if token is not None:
        if token.strip():
            data["token"] = token.strip()
        else:
            data = {}
    if data and speaker is not None:
        data["speaker"] = speaker.strip()
    if data and routines is not None:
        data["routines"] = {str(k).strip(): str(v).strip() for k, v in routines.items() if str(k).strip() and str(v).strip()}
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1), encoding="utf-8")
    return public_voicemonkey()


def public_voicemonkey() -> Dict[str, Any]:
    data = load_voicemonkey()
    return {"configured": bool(data.get("token")), "speaker": data.get("speaker", ""), "routines": data.get("routines", {})}


def _voicemonkey(endpoint: str, body: Dict[str, Any]) -> Dict[str, Any]:
    cfg = load_voicemonkey()
    req = urllib.request.Request(
        f"{VOICEMONKEY_API}/{endpoint}",
        data=json.dumps({"token": cfg.get("token", ""), **body}).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "VYRSE"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
        return {"ok": bool(data.get("success", True)), "via": "Voice Monkey"}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"Voice Monkey said HTTP {exc.code}", "via": "Voice Monkey"}
    except Exception as exc:
        return {"ok": False, "error": f"Voice Monkey unreachable: {exc}", "via": "Voice Monkey"}


def _desktop(op: str, **args: Any) -> Dict[str, Any]:
    from . import desktop_call

    return desktop_call.call("alexa", op, {k: v for k, v in args.items() if v})


def handle(params: Dict[str, Any], **_: Any) -> str:
    from .tools import _in_vyrse_session

    if not _in_vyrse_session():
        return json.dumps({"ok": False, "error": "vyrse_alexa only works in the VYRSE desktop app."})
    action = str(params.get("action") or "")
    text = str(params.get("text") or "").strip()
    device = str(params.get("device") or "").strip()
    vm = load_voicemonkey()

    if action == "devices":
        status = _desktop("status")
        return json.dumps({"alexa_signin": status, "voice_monkey": public_voicemonkey()})

    if action == "command":
        text = re.sub(r"^\s*alexa[\s,]+", "", text, flags=re.IGNORECASE)
        if not text:
            return json.dumps({"ok": False, "error": "Say what Alexa should do."})
        if _BUYING.search(text):
            from . import confirm

            if confirm.ask(f"Let Alexa do this? “{text}” (it may buy something)", ["Do it", "Cancel"]) != "Do it":
                return json.dumps({"ok": False, "error": "The user didn't approve a purchase through Alexa."})
        result = _desktop("command", text=text, device=device)
        if result.get("ok"):
            result["note"] = "Alexa is handling it on the Echo and answers out loud there."
        return json.dumps(result)

    if action == "say":
        if not text:
            return json.dumps({"ok": False, "error": "Nothing to say."})
        if vm.get("token") and vm.get("speaker") and not device:
            return json.dumps(_voicemonkey("announce", {"device": vm["speaker"], "speech": text[:500]}))
        return json.dumps(_desktop("speak", text=text, device=device))

    if action == "routine":
        name = str(params.get("name") or text).strip()
        routines = {k.lower(): v for k, v in (vm.get("routines") or {}).items()}
        if vm.get("token") and name.lower() in routines:
            return json.dumps(_voicemonkey("trigger", {"device": routines[name.lower()]}))
        # Routines with a spoken trigger phrase can be run by saying it.
        return json.dumps(_desktop("command", text=name, device=device))

    return json.dumps({"ok": False, "error": f"Unknown action {action!r}."})
