"""VYRSE interface preferences: one JSON file shared by the VYRSE UI (via plugin_api.py) and
Hermes (via the vyrse_ui tool), so human and agent change the same state.

Only *interface* preferences live here. Agent settings (model, reasoning, approvals, memory)
belong to Hermes' own config and are never duplicated.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Dict, Tuple

_LOCK = threading.Lock()

# key -> (validator description, default). Values the UI and the agent may set.
CHOICES: Dict[str, Tuple[str, ...]] = {
    "theme": ("system", "dark", "light"),
    "density": ("comfortable", "compact"),
    "animations": ("full", "reduced", "off"),
    "presenceIntensity": ("subtle", "balanced", "expressive"),
    "voiceReactivity": ("low", "medium", "high"),
    "idleActivity": ("minimal", "normal", "lively"),
    "voiceVisualization": ("minimal", "reactive", "full"),
    "mode": ("assistant", "private", "gaming"),
    "voiceReasoning": ("none", "low", "medium", "high"),
    "talkShortcut": ("ctrl+shift+space", "ctrl+alt+v", "alt+backquote", "f9", "off"),
    "dictateShortcut": ("ctrl+alt+d", "ctrl+shift+period", "f8", "off"),
    "quickShortcut": ("alt+space", "ctrl+alt+space", "alt+q", "off"),
    "glass": ("liquid", "subtle", "off"),
    "briefing": ("off", "start", "07:00", "08:00", "09:00", "10:00"),
    "talkStyle": ("normal", "vibe", "fam", "chill", "hype", "focus", "pro", "savage"),
    "accent": ("cyan", "violet", "ember", "mint", "rose"),
}
BOOLEANS = ("voiceResponses", "voiceActivation", "autoListen", "reducedMotion", "highContrast", "keyboardNav",
            "speakTyped", "autoGain", "clipboardMemory", "ghostHands")
NUMBERS: Dict[str, Tuple[float, float]] = {"textSize": (0.9, 1.25), "micSensitivity": (0.1, 1.2), "volume": (0.0, 1.0)}
STRINGS = ("micDevice", "outputDevice", "userName", "briefingGames")


def state_path() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "vyrse" / "ui_state.json"


def validate(patch: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Split a patch into accepted values and per-key errors (unknown keys are errors)."""
    ok: Dict[str, Any] = {}
    errors: Dict[str, str] = {}
    for key, value in (patch or {}).items():
        if key == "talkStyle" and isinstance(value, str) and value.startswith("custom:"):
            # a style the user made (vyrse_style); only one that still exists
            try:
                from . import styles
            except ImportError:  # loaded standalone by the dashboard API
                import importlib.util, sys
                spec = importlib.util.spec_from_file_location("vyrse_plugin_styles", Path(__file__).with_name("styles.py"))
                styles = sys.modules.get("vyrse_plugin_styles") or importlib.util.module_from_spec(spec)
                if "vyrse_plugin_styles" not in sys.modules:
                    sys.modules["vyrse_plugin_styles"] = styles
                    spec.loader.exec_module(styles)
            if value in styles.load():
                ok[key] = value
            else:
                errors[key] = "no such custom style"
        elif key == "styleVoices":
            # talk style -> Kokoro voice ("" removes); kept small and to plain voice ids
            import re as _re

            if isinstance(value, dict) and len(value) <= 24 and all(
                isinstance(k, str) and len(k) <= 40 and isinstance(v, str) and (v == "" or _re.fullmatch(r"[a-z]{2}_[a-z]{2,16}", v))
                for k, v in value.items()
            ):
                ok[key] = {k: v for k, v in value.items() if v}
            else:
                errors[key] = "must map talk styles to voice ids like af_heart"
        elif key in CHOICES:
            if value in CHOICES[key]:
                ok[key] = value
            else:
                errors[key] = f"must be one of {', '.join(CHOICES[key])}"
        elif key in BOOLEANS:
            if isinstance(value, bool):
                ok[key] = value
            else:
                errors[key] = "must be true or false"
        elif key in NUMBERS:
            lo, hi = NUMBERS[key]
            if isinstance(value, (int, float)) and not isinstance(value, bool) and lo <= float(value) <= hi:
                ok[key] = float(value)
            else:
                errors[key] = f"must be a number between {lo} and {hi}"
        elif key == "userName":
            name = " ".join(str(value).split()) if isinstance(value, str) else ""
            if name and len(name) <= 40 and all(ch.isprintable() and ch not in "<>{}[]\\\"`" for ch in name):
                ok[key] = name
            else:
                errors[key] = "must be a plain name (up to 40 characters)"
        elif key in STRINGS:
            if isinstance(value, str) and len(value) <= 200:
                ok[key] = value
            else:
                errors[key] = "must be a short string"
        else:
            errors[key] = "unknown preference"
    return ok, errors


def load() -> Dict[str, Any]:
    path = state_path()
    try:
        with _LOCK, open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        prefs = data.get("prefs", {}) if isinstance(data, dict) else {}
        accepted, _ = validate(prefs)
        return accepted
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return {}


def user_name(default: str = "the user") -> str:
    """The name the user gave VYRSE (Settings / first run), for prompts; a neutral default otherwise."""
    return load().get("userName") or default


def update(patch: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Merge a validated patch into the stored preferences; returns (all prefs, errors)."""
    accepted, errors = validate(patch)
    with _LOCK:
        path = state_path()
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            prefs = data.get("prefs", {}) if isinstance(data, dict) else {}
        except (OSError, ValueError):
            prefs = {}
        prefs.update(accepted)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "prefs": prefs}, fh, indent=1)
        os.replace(tmp, path)
    return validate(prefs)[0], errors
