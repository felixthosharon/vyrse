"""Show me where (`vyrse_point`) and ghost hands.

`vyrse_point` puts a glowing ring, an arrow and a caption around a real control on the user's screen ("where's
the export button?"), or walks through several in turn ("walk me through turning on dark mode"). The control is
found with Windows UI Automation, then OCR (locate.ps1); nothing is clicked.

Ghost hands: while VYRSE operates an app itself (vyrse_desktop), a glowing cursor glides to what it's about to
click or type into, with a caption of what it's doing and "Esc to stop" (pre_tool_call hook).
"""
from __future__ import annotations

import base64
import contextvars
import json
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_SCRIPT = Path(__file__).resolve().parent / "locate.ps1"

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_point",
    "description": (
        "On-screen help in ONE call, for whatever app or web page they're looking at (Chrome tabs included). "
        "action=guide, goal: 'show me / highlight / where do I click / how do I … / walk me through' -> it works "
        "out the app, looks up the real steps online and rings each one on screen, moving on as they click. "
        "action=do, goal: 'do it for me / export this as PDF for me' -> same steps, VYRSE clicks them itself. "
        "action=show, target: ring ONE control ('where's the share button?'; a label or what it looks like). "
        "action=next: they say next / step 2 / done during a guide. action=clear. Use this for every on-screen task; don't list steps from memory or use the terminal for it. "
        "Reply in one or two short sentences; the screen shows the rest."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["guide", "do", "show", "next", "clear"]},
            "goal": {"type": "string", "description": "guide/do: what they want to do, e.g. 'export as PDF'."},
            "target": {"type": "string", "description": "show: the control's label, or what it looks like."},
            "caption": {"type": "string", "description": "show: what to do with it, a few words."},
            "app": {"type": "string", "description": "Optional: the app or site, only if they named one."},
        },
        "required": ["action"],
    },
}


def locate(query: str, window: str = "", timeout: int = 20, mode: str = "") -> Dict[str, Any]:
    """locate.ps1: the best label match in the window, or (mode=list) every control plus a screenshot."""
    from hermes_cli._subprocess_compat import windows_hide_flags

    request: Dict[str, Any] = {"query": query or "-", "window": window}
    if mode == "list":
        request.update(mode="list", out=_look_path())
    elif mode == "sig":
        request.update(mode="sig")
    payload = base64.b64encode(json.dumps(request).encode("utf-8")).decode("ascii")
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(_SCRIPT), "-Request", payload],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
            stdin=subprocess.DEVNULL, creationflags=windows_hide_flags(),
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "Looking for it took too long."}
    lines = [line for line in (result.stdout or "").splitlines() if line.strip().startswith("{")]
    if not lines:
        return {"ok": False, "error": (result.stderr or "locate failed").strip()[-300:]}
    return json.loads(lines[-1])


_CLICKABLE_TYPES = {"Button", "MenuItem", "TabItem", "Hyperlink", "ListItem", "CheckBox", "RadioButton", "ComboBox",
                    "Edit", "TreeItem", "SplitButton", "DataItem"}


def _look_path() -> str:
    from hermes_constants import get_hermes_home

    out = Path(get_hermes_home()) / "vyrse" / "screen"
    out.mkdir(parents=True, exist_ok=True)
    return str(out / "look.png")


_FILLER = re.compile(r"^(?:the|a|an|that|this)\s+|\s+(?:button|icon|tab|menu item|option|link)$", re.I)


def _plain(query: str) -> str:
    """'the Eraser button' -> 'Eraser': what the control's own name would be."""
    text, prev = str(query or "").strip(), None
    while text != prev:
        prev, text = text, _FILLER.sub("", text).strip()
    return text or str(query or "").strip()


def find(query: str, window: str = "", timeout: int = 20) -> Dict[str, Any]:
    """Find the control the user means, by understanding the window rather than matching words.

    A control whose own accessible name is exactly the request is taken straight away. Anything less certain
    (a word that also appears in body text, an icon with no label, a description like "the gear") is decided by
    looking: every control is numbered on a screenshot and the vision model picks one, or says none."""
    hit = locate(_plain(query), window, timeout=timeout)
    if hit.get("ok") and hit.get("source") == "uia" and int(hit.get("score") or 0) >= 100 and hit.get("type") in _CLICKABLE_TYPES:
        return hit
    listing = locate(query, window, timeout=timeout, mode="list")
    if not listing.get("ok"):
        return hit if hit.get("ok") else listing
    from .. import see

    try:
        png = Path(listing["image"]).read_bytes()
    except OSError as exc:
        return {"ok": False, "error": f"Couldn't capture the window: {exc}"}
    area = listing.get("rect") or {}
    items = listing.get("items") or []
    if hit.get("ok") and hit.get("source") == "ocr":
        # text the OCR read but UI Automation doesn't expose (custom-drawn apps): one more candidate
        items = items + [{"type": "Text", "name": hit.get("name"), "rect": hit["rect"]}]
    choice = see.choose(png, items, query, origin=(area.get("x", 0), area.get("y", 0)),
                        where=f"the window '{listing.get('window')}' ({listing.get('app')})")
    if not choice.get("ok"):
        if hit.get("ok") and int(hit.get("score") or 0) >= 85:
            return hit  # the vision model couldn't decide, but the label matches closely
        return {"ok": False, "error": choice.get("error"), "labels": choice.get("labels"), "window": listing.get("window")}
    item = choice["item"]
    return {"ok": True, "rect": item["rect"], "name": see.label_of(item) or query, "type": item.get("type"),
            "source": "vision", "why": choice.get("why"), "window": listing.get("window"), "app": listing.get("app"),
            "area": area}


def where(rect: Dict[str, Any], area: Optional[Dict[str, Any]]) -> str:
    """'top left' etc.: where the control sits in its window, so the reply can say it without guessing."""
    if not rect or not area or not area.get("width") or not area.get("height"):
        return ""
    fx = (rect["x"] + rect["width"] / 2 - area["x"]) / area["width"]
    fy = (rect["y"] + rect["height"] / 2 - area["y"]) / area["height"]
    v = "top" if fy < 0.33 else "bottom" if fy > 0.67 else "middle"
    h = "left" if fx < 0.33 else "right" if fx > 0.67 else "centre"
    return "the middle" if (v, h) == ("middle", "centre") else f"the {v} {h}" if v != "middle" else f"the {h} side"


def overlay(message: Dict[str, Any]) -> bool:
    """Draw on the user's screen (the app forwards this to its overlay windows)."""
    try:
        from tools import desktop_ui

        return bool(desktop_ui.emit("vyrse.ui", {"action": "overlay", **message}))
    except Exception:
        return False


def _steps(text: str) -> List[Dict[str, str]]:
    out = []
    for line in str(text or "").splitlines():
        line = line.strip().lstrip("-*•0123456789.) ").strip()
        if not line:
            continue
        label, _, what = line.partition("::")
        if label.strip():
            out.append({"target": label.strip()[:80], "caption": what.strip()[:120]})
    return out[:8]


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = params.get("action")
    window = str(params.get("window") or params.get("app") or "")  # the app they named, not whatever is on top
    if action == "clear":
        overlay({"kind": "point", "op": "end"})
        try:
            from .. import chrome

            if chrome.connected():
                chrome.call("highlight", {"ref": None}, timeout=5)
        except Exception:
            pass
        return json.dumps({"ok": True})
    if action == "next":
        from .. import onscreen

        if onscreen.next_step():
            return json.dumps({"ok": True, "note": "Showing the next step on screen. Reply in a few words."})
        return json.dumps({"ok": False, "error": "No walkthrough is running. Start one with action=guide and the goal."})
    if action in ("guide", "do"):
        goal = str(params.get("goal") or params.get("target") or "").strip()
        if not goal:
            return json.dumps({"ok": False, "error": "goal = what they want to do, e.g. 'export as PDF'"})
        from .. import onscreen

        app = str(params.get("app") or params.get("window") or "")
        result = onscreen.guide(goal, app) if action == "guide" else onscreen.do(goal, app)
        from ..chrome import update_note

        note = update_note()
        if note:
            result["extension"] = note
        return json.dumps(result, ensure_ascii=False)
    if action == "how":
        goal = str(params.get("goal") or params.get("target") or "").strip()
        if not goal:
            return json.dumps({"ok": False, "error": "goal = what they want to do"})
        from ..lookup import how_to

        global _looked_up
        _looked_up = time.monotonic()
        return json.dumps(how_to(str(params.get("app") or window or "").strip(), goal), ensure_ascii=False)
    if action == "show":
        target = str(params.get("target") or "").strip()
        if not target:
            return json.dumps({"ok": False, "error": "target = the label to point at"})
        if _in_chrome(window):
            from ..chrome import handle as chrome_handle

            return chrome_handle({"action": "point", "target": target, "caption": params.get("caption")})
        hit = find(target, window)
        if not hit.get("ok"):
            return json.dumps({"ok": False, "error": hit.get("error"), "visible_labels": hit.get("labels"),
                               "note": "Not visible right now. Don't guess where it is: if you don't know which menu it's "
                               "under, look it up (vyrse_point action=how), or ask them to open that window."})
        caption = str(params.get("caption") or "")[:120]
        ring_clicked.clear()
        if not overlay({"kind": "point", "op": "show", "rect": hit["rect"], "label": hit.get("name") or target, "caption": caption, "hold": True}):
            return json.dumps({"ok": False, "error": "Pointing needs the VYRSE window open on this PC."})
        spot = where(hit.get("rect"), hit.get("area"))
        return json.dumps({"ok": True, "found": hit.get("name"), "in": hit.get("window"), "where": f"{spot} of the window" if spot else "",
                           "note": "Ringed on screen. Reply in one short sentence using only this (e.g. 'It's Fill, "
                                   "ringed at the top left.'). Don't add positions or details you weren't given."})
    if action == "steps":
        steps = _steps(str(params.get("steps") or ""))
        if not steps:
            return json.dumps({"ok": False, "error": "steps = lines 'label :: what to do'"})
        if time.monotonic() - _looked_up > _LOOKUP_FRESH and not _private():
            # A walkthrough from memory is how wrong steps reach the user: the real ones come from the web first.
            return json.dumps({"ok": False, "error": (
                "Look the steps up first: call vyrse_point action=how with goal (what they want to do) and app, "
                "then pass the steps it returns here. Don't list steps from memory in your reply either.")})
        if _in_chrome(window):
            from .. import chrome

            first = chrome.point({"target": steps[0]["target"], "caption": steps[0]["caption"]}, step=f"Step 1 / {len(steps)}", ms=0)
            if not first.get("ok"):
                return json.dumps({"ok": False, "error": f"Step 1 ('{steps[0]['target']}') isn't on the page: {first.get('error')}"})
            ctx = contextvars.copy_context()
            threading.Thread(target=lambda: ctx.run(_walk_chrome, steps), daemon=True, name="vyrse-point-steps").start()
            return json.dumps({"ok": True, "steps": len(steps),
                               "note": "Walking through it on the page now, one ring at a time. Reply in one sentence."})
        first = find(steps[0]["target"], window)
        if not first.get("ok"):
            return json.dumps({"ok": False, "error": f"Step 1 ('{steps[0]['target']}') isn't on screen: {first.get('error')}"})
        ctx = contextvars.copy_context()
        threading.Thread(target=lambda: ctx.run(_walk, steps, window, first), daemon=True, name="vyrse-point-steps").start()
        return json.dumps({"ok": True, "steps": len(steps),
                           "note": "Walking through it on screen now, one ring at a time. Reply in one sentence."})
    return json.dumps({"ok": False, "error": "action must be show, steps or clear"})


_LOOKUP_FRESH = 300  # a walkthrough must follow a lookup made in the last 5 minutes (outside Private mode)
_looked_up = float("-inf")


def _private() -> bool:
    """Private mode: nothing goes online, so walkthroughs can't be looked up (and aren't refused for it)."""
    try:
        from .. import ui_state

        return ui_state.load().get("mode") == "private"
    except Exception:
        return False


_STEP_WAIT = 40.0  # how long a step's ring waits for its click before the walkthrough moves on anyway


def _wait_click(event: threading.Event) -> bool:
    """Until they click the ringed control (or time runs out); then a moment for the menu or dialog to open."""
    clicked = event.wait(_STEP_WAIT)
    time.sleep(1.1 if clicked else 0.2)
    return clicked


def _walk_chrome(steps: List[Dict[str, str]]) -> None:
    """Step 1 is up already. Each click on a ring brings the next step (found afresh: menus open in between)."""
    from .. import chrome

    n = len(steps)
    for i, step in enumerate(steps[1:], 2):
        _wait_click(chrome.ring_clicked)
        shown = None
        for _ in range(3):  # the menu the next step lives in may still be opening
            try:
                shown = chrome.point({"target": step["target"], "caption": step["caption"]}, step=f"Step {i} / {n}", ms=0)
            except Exception:
                shown = None
            if shown and shown.get("ok"):
                break
            time.sleep(1.2)
    _wait_click(chrome.ring_clicked)
    try:
        chrome.call("highlight", {"ref": None})
    except Exception:
        pass


def _in_chrome(window: str) -> bool:
    """Pointing at a web page goes through the VYRSE extension (an exact ring in the page) when it's connected and
    Chrome is the app they mean (named, or the window they're on)."""
    try:
        from .. import chrome

        if not chrome.connected():
            return False
    except Exception:
        return False
    if window:
        return "chrome" in window.lower()
    top = locate("-", "", timeout=8)
    return str(top.get("app") or "").lower() == "chrome"


# set when the user clicks inside the on-screen ring (the app's overlay reports it: POST /point/clicked)
ring_clicked = threading.Event()


def _walk(steps: List[Dict[str, str]], window: str, first: Dict[str, Any]) -> None:
    n = len(steps)
    for i, step in enumerate(steps):
        hit = first if i == 0 else {}
        for _ in range(3 if i else 0):  # the next control may be in a menu that's still opening
            hit = find(step["target"], window)
            if hit.get("ok"):
                break
            time.sleep(1.2)
        if hit.get("ok"):
            ring_clicked.clear()
            overlay({"kind": "point", "op": "show", "rect": hit["rect"], "label": hit.get("name") or step["target"],
                     "caption": step["caption"], "step": f"Step {i + 1} / {n}", "hold": True})
            _wait_click(ring_clicked)
    overlay({"kind": "point", "op": "end"})


# --------------------------------------------------------------------------------------------- ghost hands
_DESKTOP_VERBS = {"open": "Opening", "type": "Typing into", "click": "Clicking", "close": "Closing", "arrange": "Moving",
                  "keys": "Pressing", "focus": "Switching to", "read": "Reading"}


def ghost_caption(tool: str, args: Dict[str, Any]) -> Optional[str]:
    if tool == "vyrse_desktop":
        action = str(args.get("action") or "")
        verb = _DESKTOP_VERBS.get(action)
        if not verb:
            return None
        if action == "open":
            return f"Opening {str(args.get('target') or '')[:60]}"
        if action == "type":
            text = str(args.get("text") or "").replace("\n", " ")
            return f"Typing “{text[:48]}{'…' if len(text) > 48 else ''}”"
        if action == "click":
            return f"Clicking {str(args.get('name') or '')[:50]}"
        if action == "keys":
            return f"Pressing {str(args.get('keys') or '')[:30]}"
        if action == "arrange":
            return f"Moving {str(args.get('window') or 'the window')[:40]} {str(args.get('position') or '')[:20]}".strip()
        return f"{verb} {str(args.get('window') or '')[:50]}".strip()
    if tool == "vyrse_chrome":
        action = str(args.get("action") or "")
        what = str(args.get("target") or "")[:40]
        if action == "click":
            return f"Clicking {what}" if what else "Clicking in Chrome"
        if action == "type":
            text = str(args.get("text") or "").replace("\n", " ")
            return f"Typing “{text[:48]}{'…' if len(text) > 48 else ''}”"
        if action in ("open", "go"):
            return f"Opening {str(args.get('url') or '')[:50]}"
        if action == "search":
            return f"Searching “{str(args.get('query') or '')[:48]}”"
        if action == "read":
            return "Reading the page"
        if action == "look":
            return "Looking at the page"
        return None
    if tool == "computer_use":
        action = str(args.get("action") or "")
        if action in ("click", "double_click", "right_click"):
            return "Clicking"
        if action == "type":
            text = str(args.get("text") or "").replace("\n", " ")
            return f"Typing “{text[:48]}{'…' if len(text) > 48 else ''}”"
        if action in ("key", "keys", "press"):
            return f"Pressing {str(args.get('keys') or args.get('text') or '')[:30]}"
        if action == "scroll":
            return f"Scrolling {args.get('direction') or ''}".strip()
        return None
    return None


def _ghost_on() -> bool:
    try:
        from .. import ui_state

        return ui_state.load().get("ghostHands", True) is not False
    except Exception:
        return True


def pre_tool_call(tool_name: str = "", args: Optional[Dict[str, Any]] = None, **_: Any) -> None:
    """Before VYRSE operates an app: the ghost cursor goes to the control first, then the action happens."""
    if tool_name not in ("vyrse_desktop", "computer_use", "vyrse_chrome") or not isinstance(args, dict):
        return None
    caption = ghost_caption(tool_name, args)
    if not caption or not _ghost_on():
        return None
    # a click's target is found by looking first (desktop.handle -> ghost_to), so only the caption goes up here
    overlay({"kind": "ghost", "op": "move", "caption": caption})
    return None


def ghost_to(rect: Dict[str, Any], caption: str) -> None:
    """The ghost cursor glides to a control just before VYRSE presses it."""
    if _ghost_on() and overlay({"kind": "ghost", "op": "move", "caption": caption, "rect": rect}):
        time.sleep(0.9)


def post_llm_call(platform: str = "", **_: Any) -> None:
    """The turn is over: the ghost cursor goes away."""
    if platform == "vyrse":
        overlay({"kind": "ghost", "op": "end"})
