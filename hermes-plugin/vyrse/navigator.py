"""Getting somewhere on screen, one look at a time (vyrse_point action=guide / action=do).

A fixed list of steps from a help page breaks as soon as the screen doesn't match it (a different starting page, an
app update, a menu that opens as a pop-up). So each step is decided by looking: the app's window and any pop-up of it
are read (UI Automation + on-screen text), the controls are numbered on a screenshot, and the vision model picks the
ONE control that gets closer to the goal, or says a site has to be opened first, or that the goal is reached. Help
page steps are only hints. guide rings that control and waits for the user's click (or "next", or the screen
changing), then looks again; do clicks it itself. A walkthrough keeps going until it's done, up to MAX_STEPS.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

MAX_STEPS = 10
STEP_WAIT = 150.0  # how long a ring waits for its click

PLAN = {"type": "object", "properties": {
    "mark": {"type": ["integer", "null"]},
    "open_url": {"type": ["string", "null"], "maxLength": 160},
    "done": {"type": "boolean"},
    "why": {"type": "string", "maxLength": 90}},
    "required": ["mark", "open_url", "done", "why"]}

# Well-known places: when the goal names one that isn't open, it's opened (no guessing at "New Tab" buttons).
# (pattern in the goal, host it lives on, home address, address of its settings when there is a direct one)
SITES = [
    (r"\bg ?mail\b", "mail.google.com", "https://mail.google.com/", "https://mail.google.com/mail/u/0/#settings/general"),
    (r"\bgoogle account|\bmy account|account (?:settings|management)\b", "myaccount.google.com",
     "https://myaccount.google.com/", "https://myaccount.google.com/personal-info"),
    (r"\byou ?tube\b", "youtube.com", "https://www.youtube.com/", "https://www.youtube.com/account"),
    (r"\bgoogle drive\b|\bmy drive\b", "drive.google.com", "https://drive.google.com/", None),
    (r"\bgoogle docs\b", "docs.google.com", "https://docs.google.com/document/", None),
    (r"\bgoogle calendar\b", "calendar.google.com", "https://calendar.google.com/", "https://calendar.google.com/calendar/u/0/r/settings"),
    (r"\boutlook\b", "outlook.live.com", "https://outlook.live.com/mail/", None),
    (r"\bwhatsapp web\b", "web.whatsapp.com", "https://web.whatsapp.com/", None),
    (r"\bchrome settings\b|\bsettings (?:in|of) chrome\b", "settings", "chrome://settings/", None),
]


def site_for(goal: str, url: str) -> Optional[Dict[str, str]]:
    """The site the goal is about when it isn't the page they're on (and where its settings are)."""
    for pattern, host, home, settings in SITES:
        if re.search(pattern, goal, re.I):
            if host in (url or ""):
                return None
            return {"host": host, "home": home, "settings": settings or ""}
    return None


_lock = threading.Lock()
_run_id = 0
active = threading.Event()  # a walkthrough is on screen
next_said = threading.Event()  # they said "next"
_advanced_at = [0.0]


def cancel() -> bool:
    """Esc ("I've got it") or a new request: drop the walkthrough or run in progress. The loop checks before every
    look, click and wait, so nothing more is clicked after this. Returns whether one was running."""
    global _run_id
    with _lock:
        was = active.is_set()
        _run_id += 1
        active.clear()  # the cancelled run won't (its id is stale), so nothing is "on screen" any more
    _clear()
    return was


def _halted(me: int) -> bool:
    """A newer request took over, Esc was pressed, or the turn was interrupted (do mode runs on the tool's thread)."""
    if me != _run_id:
        return True
    try:
        from tools.interrupt import is_interrupted

        return is_interrupted()
    except Exception:
        return False


# --------------------------------------------------------------------------------------- looking
def look(window: str) -> Optional[Dict[str, Any]]:
    """The window and its pop-ups: a screenshot, every control, and the visible text as extra candidates."""
    from . import see
    from .point import locate

    listing = locate("-", window, mode="list", timeout=25)
    if not listing.get("ok"):
        return None
    try:
        png = Path(listing["image"]).read_bytes()
    except OSError:
        return None
    area = listing.get("rect") or {"x": 0, "y": 0}
    pops = listing.get("popup_rects") or []

    def in_popup(r: Dict[str, Any]) -> bool:
        cx, cy = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
        return any(p["x"] <= cx <= p["x"] + p["width"] and p["y"] <= cy <= p["y"] + p["height"] for p in pops)

    items = [dict(i, pop=in_popup(i["rect"])) for i in listing.get("items") or [] if i.get("enabled", True)]
    # visible text the accessibility tree doesn't list (canvas apps, custom menus)
    for line in see.ocr_items(see.ocr_lines(png), limit=60):
        r = line["rect"]
        rect = {"x": r["x"] + area["x"], "y": r["y"] + area["y"], "width": r["width"], "height": r["height"]}
        if not any(_overlaps(rect, i["rect"]) for i in items):
            items.append({"type": "Text", "name": line["name"], "rect": rect, "pop": in_popup(rect)})
    return {"png": png, "items": items, "area": area, "popups": len(pops), "window": listing.get("window"),
            "app": listing.get("app"), "viewport": listing.get("viewport")}


def _overlaps(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    ax, ay = a["x"] + a["width"] / 2, a["y"] + a["height"] / 2
    return b["x"] <= ax <= b["x"] + b["width"] and b["y"] <= ay <= b["y"] + b["height"]


def _candidates(view: Dict[str, Any], goal: str, hints: List[str]) -> List[Dict[str, Any]]:
    """What gets a number: everything in an open pop-up first (that's where the next click usually is), then the
    controls whose words fit the goal and the hint steps, then the rest."""
    from . import see

    pops = [i for i in view["items"] if i.get("pop")][:30]
    rest = see.shortlist([i for i in view["items"] if not i.get("pop")], f"{goal} {' '.join(hints)}", limit=60 - len(pops))
    return pops + rest


def decide(view: Dict[str, Any], goal: str, hints: List[str], history: List[str], where: str) -> Dict[str, Any]:
    from . import see

    marks = _candidates(view, goal, hints)
    if not marks:
        return {"error": "nothing to click on screen"}
    area = view["area"]
    picture = see.draw_marks(view["png"], marks, origin=(area.get("x", 0), area.get("y", 0)))
    see._keep(picture)
    listing = "\n".join(see._describe(i, m) + (" (in the open menu)" if m.get("pop") else "") for i, m in enumerate(marks, 1))
    prompt = (
        f"You're helping someone use their PC. Their goal: \"{goal}\".\n"
        f"On screen: {where}{' (a menu or pop-up is open: its items are listed first)' if view.get('popups') else ''}.\n"
        f"Done so far: {'; '.join(history) if history else 'nothing yet'}.\n"
        + (f"A help page suggests these steps (they may not match this screen exactly): {' > '.join(hints)}.\n" if hints else "")
        + f"\nNumbered controls on screen (coloured boxes in the picture):\n{listing}\n\n"
        "What is the ONE next thing to click to get closer to the goal?\n"
        "- If what they wanted is already showing on screen, answer done=true.\n"
        "- If they first need a website that isn't open (e.g. the goal is in Gmail but this is another page), give "
        "open_url (a full https address) and mark null.\n"
        "- Otherwise give the mark number of the control to click: a button, menu item, tab, link or field, never a "
        "status line or message. Use icons and labels; only numbers from the list. If you're not sure any of them "
        "helps, mark null.\n"
        'Reply as JSON: {"mark": <number or null>, "open_url": <url or null>, "done": <true/false>, "why": "<short reason>"}'
    )
    try:
        answer = see.ask_vision(picture, prompt, max_tokens=140, schema=PLAN)
        data = json.loads(answer[answer.index("{"): answer.rindex("}") + 1])
    except Exception as exc:
        logger.warning("vyrse: navigator couldn't decide: %s", exc)
        return {"error": f"couldn't look at the screen ({exc})"}
    logger.info("vyrse: navigator %r -> %s", goal, data)
    if data.get("done"):
        return {"done": True, "why": data.get("why")}
    url = str(data.get("open_url") or "").strip()
    if url and re.match(r"https?://[\w.-]+\.\w{2,}", url):
        return {"open_url": url, "why": data.get("why")}
    try:
        n = int(data.get("mark"))
    except (TypeError, ValueError):
        return {"error": "it can't see a control that leads there"}
    if not 1 <= n <= len(marks):
        return {"error": "it can't see a control that leads there"}
    item = marks[n - 1]
    return {"item": item, "label": see.label_of(item) or "that", "why": data.get("why"), "viewport": view.get("viewport")}


def reached(view: Dict[str, Any], goal: str, history: List[str]) -> bool:
    """After a click: is what they wanted done or showing now? (A separate yes/no look: a model asked for "the
    next click" always finds one, so it never stopped.)"""
    from . import see

    try:
        answer = see.ask_vision(view["png"], (
            f"Someone wanted to: \"{goal}\". They have done: {'; '.join(history)}.\n"
            "Look at this screenshot. Is that goal now achieved, or is the screen or setting they wanted now open in "
            "front of them? A message like 'downloaded', 'saved', 'sent', or the requested settings page counts as yes. "
            "A menu, or a dialog still waiting for them to press a button (Download, Save, OK, Apply) to finish, counts as no.\n"
            'Answer {"answer": "yes"} or {"answer": "no"}.'), max_tokens=20, schema=see.YES_NO)
    except Exception:
        return False
    logger.info("vyrse: navigator reached %r? %s", goal, answer)
    return '"yes"' in answer.lower()


# --------------------------------------------------------------------------------------- acting
def caption_for(label: str, why: str) -> str:
    """The line under a ring: what to click, and the model's reason without its bookkeeping ("control 3")."""
    why = re.sub(r"\s*\(?\b(?:control|mark|box|number)\s*#?\d+\)?", "", why or "", flags=re.I)
    why = re.sub(r"^(?:the user (?:wants|needs) to [^.]*\.\s*|clicking\s+)", "", why.strip(), flags=re.I)
    why = re.split(r"(?<=[.!?])\s", why)[0].strip(" .")
    head = f"Click {label}"
    return f"{head}: {why[0].lower()}{why[1:]}"[:110] if why and label.lower() not in why.lower()[:len(label) + 12] else head


def _ring(item: Dict[str, Any], label: str, caption: str, step: int) -> None:
    from . import chrome, point

    chrome.ring_clicked.clear()
    point.ring_clicked.clear()
    point.overlay({"kind": "point", "op": "show", "rect": item["rect"], "label": label[:80], "caption": caption[:140],
                   "step": f"Step {step}", "hold": True})


def _clear() -> None:
    from .point import overlay

    overlay({"kind": "point", "op": "end"})


def _click(item: Dict[str, Any], label: str, window: str, ctx: Dict[str, Any], viewport: Optional[Dict[str, Any]]) -> None:
    """Inside a Chrome page: a real browser click through the extension (web menus are often plain elements
    with nothing for UI Automation to press, and frames are no problem). Elsewhere (Chrome's own toolbar and
    menus, other apps): pressed through UI Automation, the mouse only as a last resort."""
    from . import chrome
    from .desktop import run
    from .point import ghost_to

    r = item["rect"]
    cx, cy = r["x"] + r["width"] / 2, r["y"] + r["height"] / 2
    ghost_to(r, f"Clicking {label}"[:60])
    v = viewport or {}
    if (ctx.get("surface") == "chrome" and chrome.connected() and v.get("width")
            and v["x"] <= cx < v["x"] + v["width"] and v["y"] <= cy < v["y"] + v["height"]):
        try:
            dpr = float(chrome.call("snapshot", {"tab": ctx.get("tab")}, timeout=10).get("dpr") or 1)
            x, y = (cx - v["x"]) / dpr, (cy - v["y"]) / dpr
            chrome.call("click", {"rect": {"x": x - 1, "y": y - 1, "width": 2, "height": 2}, "tab": ctx.get("tab")}, timeout=30)
            return
        except Exception as exc:
            logger.info("vyrse: page click failed, pressing it instead: %s", exc)
    out = run({"action": "click", "window": window, "name": label, "x": int(cx), "y": int(cy)})
    if not out.get("ok"):
        raise RuntimeError(out.get("error") or "couldn't click it")


def _open(url: str, ctx: Dict[str, Any]) -> None:
    from . import chrome

    if ctx.get("surface") == "chrome" and chrome.connected():
        chrome.call("go", {"url": url, "tab": ctx.get("tab")}, timeout=40)
    else:
        from .desktop import run

        run({"action": "open", "target": url})
    time.sleep(2.0)


def _signature(window: str) -> str:
    from .point import locate

    return str(locate("-", window, mode="sig", timeout=10).get("sig") or "")


def _wait_for_user(window: str, me: int) -> bool:
    """Until they click the ring, say "next", or what's on screen changes (their click opened something)."""
    from . import chrome, point

    before = _signature(window)
    end = time.monotonic() + STEP_WAIT
    checked = time.monotonic()
    while time.monotonic() < end:
        if _halted(me):
            return False
        if chrome.ring_clicked.is_set() or point.ring_clicked.is_set() or next_said.is_set():
            return True
        if time.monotonic() - checked > 1.5:
            checked = time.monotonic()
            now = _signature(window)
            if before and now and now != before:
                return True
        time.sleep(0.25)
    return False


def _tell(text: str) -> None:
    try:
        from tools import desktop_ui

        desktop_ui.emit("vyrse.ui", {"action": "notify", "text": text[:200]})
    except Exception:
        pass


_RISKY = re.compile(r"\b(delete|remove|erase|send|pay|buy|purchase|order|post|publish|submit|sign out|log out|"
                    r"unsubscribe|format|reset|uninstall|discard)\b", re.I)


# --------------------------------------------------------------------------------------- the walk
def _hints(goal: str, ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Steps from a help page, as hints (the lookup is for the app they're in; a bare browser says nothing)."""
    from .lookup import how_to
    from .point import _steps

    app = str(ctx.get("app") or "")
    if app in ("Google Chrome", "a website") or app.endswith("(website)"):
        app = ""
    try:
        found = how_to(app, goal)
    except Exception:
        return {"steps": [], "source": None}
    return {"steps": [s["target"] for s in _steps(str(found.get("steps") or ""))][:8] if found.get("ok") else [],
            "source": found.get("source")}


def start(goal: str, mode: str, ctx: Dict[str, Any], private: bool) -> Dict[str, Any]:
    """Decide the first step now (so the reply says what's happening); guide carries on in the background, do
    clicks through to the end before answering."""
    global _run_id
    from .onscreen import describe

    window = str(ctx.get("proc") or ctx.get("window") or "")
    hints = {"steps": [], "source": None} if private else _hints(goal, ctx)
    with _lock:
        _run_id += 1
        me = _run_id
    next_said.clear()
    if os.environ.get("VYRSE_ONSCREEN_DRY"):  # tests of the model's routing: never touch the real screen
        return {"ok": True, "dry_run": True, "on_screen": describe(ctx), "hints": hints["steps"]}
    history: List[str] = []
    site = site_for(goal, str(ctx.get("url") or "")) if ctx.get("surface") == "chrome" else None
    if site:
        # do: straight to the settings when that's what they asked for; guide: open the site, then show the way
        direct = site["settings"] if (mode == "do" and site["settings"] and re.search(r"setting|account|manage|preference", goal, re.I)) else ""
        _open(direct or site["home"], ctx)
        ctx = dict(ctx, url=direct or site["home"])
        history.append(f"opened {direct or site['home']}")
    if mode == "do":
        return _walk(goal, "do", ctx, window, hints, me, {"history": history} if history else None)
    first = _step(goal, ctx, window, hints, history, 1)
    first["history"] = history
    if first.get("stop"):
        return {"ok": False, "on_screen": describe(ctx), **first["stop"]}
    threading.Thread(target=_walk, args=(goal, "guide", ctx, window, hints, me, first), daemon=True,
                     name="vyrse-guide").start()
    return {"ok": True, "on_screen": describe(ctx), "first": first.get("label"), "why": first.get("why"),
            "source": hints.get("source"),
            "note": "Step 1 is ringed on screen. VYRSE looks again after each click and rings the next one until "
                    "they're there. Reply in one short sentence."}


def _step(goal: str, ctx: Dict[str, Any], window: str, hints: Dict[str, Any], history: List[str], n: int) -> Dict[str, Any]:
    """One look -> {item,label,why} | {opened} | {done} | {stop: {...}}. Opening a site happens here (both modes)."""
    from .onscreen import describe

    for attempt in range(3):
        view = look(window)
        if view is None:
            time.sleep(1.0)
            continue
        if history and attempt == 0 and reached(view, goal, history):
            return {"done": True, "why": "the goal is on screen"}
        d = decide(view, goal, hints["steps"], history, describe(ctx))
        if d.get("done"):
            return {"done": True, "why": d.get("why")}
        if d.get("open_url"):
            _open(d["open_url"], ctx)
            history.append(f"opened {d['open_url']}")
            continue
        if d.get("item"):
            return d
        time.sleep(1.2)  # something may still be opening
    return {"stop": {"error": f"Step {n}: I can't see what to click next to {goal}.", "done_so_far": history}}


def _walk(goal: str, mode: str, ctx: Dict[str, Any], window: str, hints: Dict[str, Any], me: int,
          first: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    history: List[str] = list(first.get("history", [])) if first else []
    active.set()
    last = ""
    try:
        for n in range(1, MAX_STEPS + 1):
            if _halted(me):
                return {"ok": False, "stopped": True, "done_so_far": history,
                        "note": "Stopped: the user took the controls back. Don't retry; say so in a few words."}
            d = first if (first and n == 1 and ("item" in first or "done" in first or "stop" in first)) else _step(goal, ctx, window, hints, history, n)
            if d.get("done"):
                if mode == "guide":
                    _clear()
                    _tell(f"Done: that's everything for \"{goal}\".")
                return {"ok": True, "done": history, "reached": True, "source": hints.get("source"),
                        "note": "They're there. Say what you did in one sentence."}
            if d.get("stop"):
                if mode == "guide":
                    _clear()
                    _tell(d["stop"]["error"])
                return {"ok": False, **d["stop"], "source": hints.get("source")}
            label, item = d["label"], d["item"]
            if label == last and n > 1:  # the same thing again: the click didn't take it anywhere
                msg = f"Step {n}: '{label}' again, so I'm stuck here. Tell me what you see and I'll look again."
                if mode == "guide":
                    _clear()
                    _tell(msg)
                return {"ok": False, "error": msg, "done_so_far": history}
            last = label
            if mode == "guide":
                _ring(item, label, caption_for(label, d.get("why") or ""), n)
                if not _wait_for_user(window, me):
                    _clear()
                    return {"ok": False, "error": "stopped waiting"}
                next_said.clear()
                _advanced_at[0] = time.monotonic()
                history.append(f"clicked '{label}'")
                time.sleep(1.0)  # let the menu or page open
            else:
                if _RISKY.search(label):
                    from .confirm import ask

                    if ask(f"Click '{label}'?", ["Yes, click it", "No"]) != "Yes, click it":
                        return {"ok": False, "done": history, "stopped_at": f"They didn't want me to click '{label}'."}
                if _halted(me):
                    return {"ok": False, "stopped": True, "done_so_far": history,
                            "note": "Stopped: the user took the controls back. Don't retry; say so in a few words."}
                try:
                    _click(item, label, window, ctx, d.get("viewport"))
                except Exception as exc:
                    return {"ok": False, "done": history, "stopped_at": f"Step {n}: couldn't click '{label}': {exc}"}
                history.append(f"clicked '{label}'")
                time.sleep(1.5)
        if mode == "guide":
            _clear()
        return {"ok": False, "error": f"Still not there after {MAX_STEPS} steps.", "done_so_far": history}
    finally:
        if me == _run_id:
            active.clear()


def say_next() -> bool:
    if not active.is_set():
        return False
    if time.monotonic() - _advanced_at[0] > 4:  # one "next" per step, however many times the model says it
        next_said.set()
    return True
