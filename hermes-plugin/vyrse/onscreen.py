"""On-screen help that doesn't depend on a small model chaining tools: one call does the whole job.

`guide(goal)`: find out what the user is looking at (the app, or the Chrome tab and its site), look the real
steps up (help pages, with the source), then ring each step on screen and move on when they click it.
`do(goal)`: the same steps, but VYRSE clicks them itself, checking each one is on screen before it clicks.

Everything is found the same way, wherever it is: exact labels, then visible text (Windows OCR), then the vision
model looking at the screenshot, with a close-up check. Nothing found = nothing clicked, and it says which step.
"""
from __future__ import annotations

import logging
import os
import contextvars
import re
import threading
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------------------- what's on screen
_SITES = [
    (r"word\.cloud\.microsoft|word-edit\.officeapps|onedrive\.live\.com/edit.*\.docx|\.docx", "Word for the web"),
    (r"excel\.cloud\.microsoft|excel\.officeapps|\.xlsx", "Excel for the web"),
    (r"powerpoint\.cloud\.microsoft|powerpoint\.officeapps|\.pptx", "PowerPoint for the web"),
    (r"docs\.google\.com/document", "Google Docs"), (r"docs\.google\.com/spreadsheets", "Google Sheets"),
    (r"docs\.google\.com/presentation", "Google Slides"), (r"mail\.google\.com", "Gmail"),
    (r"drive\.google\.com", "Google Drive"), (r"youtube\.com", "YouTube"), (r"canva\.com", "Canva"),
    (r"figma\.com", "Figma"), (r"notion\.so", "Notion"), (r"outlook\.(live|office)\.com", "Outlook on the web"),
    (r"web\.whatsapp\.com", "WhatsApp Web"), (r"discord\.com", "Discord (web)"), (r"github\.com", "GitHub"),
]
_APPS = {"winword": "Microsoft Word", "excel": "Microsoft Excel", "powerpnt": "Microsoft PowerPoint",
         "explorer": "File Explorer", "code": "Visual Studio Code", "spotify": "Spotify", "discord": "Discord",
         "mspaint": "Paint", "notepad": "Notepad", "vlc": "VLC media player", "steam": "Steam", "obs64": "OBS Studio",
         "photoshop": "Adobe Photoshop", "acrobat": "Adobe Acrobat", "teams": "Microsoft Teams", "outlook": "Outlook",
         "systemsettings": "Windows Settings", "msedge": "Microsoft Edge", "firefox": "Firefox", "chrome": "Google Chrome"}


def _site_name(url: str, title: str) -> str:
    probe = f"{url} {title}"
    for pattern, name in _SITES:
        if re.search(pattern, probe, re.I):
            return name
    host = urlparse(url).netloc.removeprefix("www.")
    return f"{host} (website)" if host else "a website"


def _current_tab(top_title: str) -> Optional[Dict[str, Any]]:
    """The Chrome tab they're on. Older extensions don't know 'current': then the active tab whose title is the
    Chrome window's."""
    from . import chrome

    if not chrome.connected():
        return None
    try:
        return chrome.call("current", {}, timeout=8)
    except Exception as exc:
        if "Unknown command" not in str(exc):
            return None
    try:
        tabs = [t for t in chrome.call("tabs", {}, timeout=8).get("tabs") or [] if t.get("active")]
    except Exception:
        return None
    name = re.sub(r"\s+-\s+Google Chrome$", "", top_title or "").strip()
    return next((t for t in tabs if name and str(t.get("title") or "").strip() == name), tabs[0] if len(tabs) == 1 else None)


def screen_context(app_hint: str = "") -> Dict[str, Any]:
    """{surface: chrome|desktop, app, title, window, url?, tab?}: what they're looking at (or the app they named)."""
    from .point import locate

    top = locate("-", "", timeout=8)  # the window behind VYRSE
    top_app = str(top.get("app") or "").lower()
    top_title = str(top.get("window") or "")
    hint = app_hint.strip().lower()
    tab = _current_tab(top_title) if top_app == "chrome" or hint else None
    if tab and (top_app == "chrome" or (hint and _hint_matches_tab(hint, tab))):
        url, title = str(tab.get("url") or ""), str(tab.get("title") or "")
        app = "Google Chrome" if re.match(r"(chrome|edge|about):", url) else _site_name(url, title)
        return {"surface": "chrome", "app": app, "title": title, "url": url, "tab": tab.get("tab"),
                "window": top_title if top_app == "chrome" else "chrome", "proc": "chrome"}
    window = app_hint if (hint and hint not in ("chrome", "google chrome", top_app)) else ""
    if window:
        named = locate("-", window, timeout=8)
        if named.get("window"):
            app = _APPS.get(str(named.get("app") or "").lower(), named.get("app") or app_hint)
            return {"surface": "desktop", "app": app, "title": named.get("window"), "window": named.get("window"),
                    "proc": str(named.get("app") or "")}
    app = _APPS.get(top_app, top.get("app") or "the app")
    return {"surface": "desktop", "app": app, "title": top_title, "window": top_title, "proc": top_app}


def _hint_matches_tab(hint: str, tab: Dict[str, Any]) -> bool:
    words = [w for w in re.split(r"\W+", hint) if len(w) > 2 and w not in ("the", "for", "web", "online", "app")]
    probe = f"{tab.get('url')} {tab.get('title')} {_site_name(str(tab.get('url') or ''), str(tab.get('title') or ''))}".lower()
    return bool(words) and any(w in probe for w in words)


def describe(ctx: Dict[str, Any]) -> str:
    if ctx.get("surface") == "chrome":
        return f"'{ctx.get('title')}' ({ctx.get('app')}) in their Chrome"
    return f"'{ctx.get('title')}' ({ctx.get('app')})" if ctx.get("title") else "the desktop"


# --------------------------------------------------------------------------------------- one place to act
class Surface:
    """Find / ring / click a control. In Chrome the page comes first (through the extension); Chrome's own
    toolbar, menus and chrome:// pages aren't in any page, so they're found like any Windows app (UI Automation,
    on-screen text, the vision model) and ringed by VYRSE's overlay. Each found control remembers which way."""

    def __init__(self, ctx: Dict[str, Any]):
        self.ctx = ctx
        self.chrome = ctx.get("surface") == "chrome"
        self.via = "page" if self.chrome else "desktop"  # how the current ring was drawn

    def find(self, label: str, hint: str = "") -> Optional[Dict[str, Any]]:
        wordings = _requests(label, hint)
        if self.chrome:
            found = self._find_page(wordings)
            if found:
                return found
        return self._find_desktop(wordings)

    def _find_page(self, wordings: List[str]) -> Optional[Dict[str, Any]]:
        from .chrome import resolve

        try:
            found = resolve(wordings, self.ctx.get("tab"))
        except Exception as exc:  # chrome:// pages, the Web Store: the extension can't look
            logger.info("vyrse: page find %r: %s", wordings[0], exc)
            return None
        if not found.get("ok"):
            return None
        if "rect" in found:
            return {"ok": True, "via": "page", "rect": found["rect"], "tab": found.get("tab"), "name": wordings[0]}
        e = found["element"]
        return {"ok": True, "via": "page", "ref": int(e["ref"]), "tab": found.get("tab"), "name": e.get("name") or wordings[0]}

    def _find_desktop(self, wordings: List[str]) -> Optional[Dict[str, Any]]:
        from .point import _plain, find, locate

        window = str(self.ctx.get("window") or "")
        try:
            for wording in wordings[:-1]:  # quick exact-label checks first
                hit = locate(_plain(wording), window, timeout=10)
                if hit.get("ok") and int(hit.get("score") or 0) >= 85:
                    return {**hit, "via": "desktop"}
            found = find(wordings[-1], window)
        except Exception as exc:
            logger.info("vyrse: desktop find %r failed: %s", wordings[0], exc)
            return None
        return {**found, "via": "desktop"} if found.get("ok") else None

    def quick_find(self, label: str, hint: str = "") -> bool:
        return self.quick_state(label, hint)[0]

    def quick_state(self, label: str, hint: str = "") -> tuple:
        """(is it on screen?, a fingerprint of the page). Labels and text only, no vision model: cheap enough to
        ask every couple of seconds. The fingerprint changes when the page does (their click opened something)."""
        from .point import _plain, locate

        wordings = _requests(label, hint)[:-1] or [label]
        print_ = ""
        if self.chrome:
            try:  # the page's own controls and text, every frame
                import hashlib

                from .chrome import _norm, call

                snap = call("snapshot", {"tab": self.ctx.get("tab"), "text": True}, timeout=10)
                names = {_norm(e.get("name")) for e in snap.get("elements") or []}
                text = f" {_norm(snap.get('text'))} "
                print_ = hashlib.md5((text + "|".join(sorted(names))).encode("utf-8")).hexdigest()
                if any(_norm(w) in names or f" {_norm(w)} " in text for w in wordings if _norm(w)):
                    return True, print_
            except Exception:
                pass
        window = str(self.ctx.get("window") or "")
        for wording in wordings:
            try:
                hit = locate(_plain(wording), window, timeout=8)
            except Exception:
                continue
            if hit.get("ok") and int(hit.get("score") or 0) >= 85:
                return True, print_
        return False, print_

    def ring(self, found: Dict[str, Any], caption: str, step: str) -> None:
        self.clear()
        self.via = found.get("via") or ("page" if self.chrome else "desktop")
        from . import chrome, point

        chrome.ring_clicked.clear()
        point.ring_clicked.clear()
        if self.via == "page":
            chrome.call("highlight", {**_where_of(found), "caption": caption[:120], "step": step, "ms": 0, "tab": found.get("tab")})
        else:
            point.overlay({"kind": "point", "op": "show", "rect": found["rect"], "label": found.get("name") or "",
                           "caption": caption[:140], "step": step, "hold": True})

    def clicked(self) -> bool:
        from . import chrome, point

        return chrome.ring_clicked.is_set() or point.ring_clicked.is_set() or _next.is_set()

    def clear(self) -> None:
        from . import chrome, point

        try:
            if self.chrome:
                chrome.call("highlight", {"ref": None}, timeout=5)
        except Exception:
            pass
        point.overlay({"kind": "point", "op": "end"})

    def click(self, found: Dict[str, Any]) -> Dict[str, Any]:
        if found.get("via") == "page":
            from .chrome import call

            return call("click", {**_where_of(found), "tab": found.get("tab")}, timeout=40)
        from .desktop import run
        from .point import ghost_to

        r = found["rect"]
        ghost_to(r, f"Clicking {found.get('name') or ''}"[:60])
        return run({"action": "click", "window": self.ctx.get("window"), "name": found.get("name") or "",
                    "x": r["x"] + r["width"] // 2, "y": r["y"] + r["height"] // 2})


def _where_of(found: Dict[str, Any]) -> Dict[str, Any]:
    return {"ref": found["ref"]} if found.get("ref") is not None else {"rect": found["rect"]}


def _requests(label: str, hint: str) -> List[str]:
    """What to look for: the control's label as written, its parts ('Download as PDF ... Export without
    comments' -> 'Download as PDF'), a quoted name in the step text, then the whole step for the vision model."""
    out: List[str] = []
    label = re.sub(r"^(click|select|choose|tap|press|open|go to)\s+", "", label.strip(), flags=re.I).strip(" .:")
    for part in [label, *re.split(r"\s*(?:\.\.\.|…|>|→|/|,)\s*", label)]:
        part = part.strip(" .\"'")
        if part and len(part.split()) <= 6 and part not in out:
            out.append(part)
    for quoted in re.findall(r"[\"“']([^\"”']{2,40})[\"”']", hint or ""):
        if quoted not in out:
            out.append(quoted)
    whole = f"{label} ({hint})" if hint and hint.lower() != label.lower() else label
    if whole not in out:
        out.append(whole)
    return out[:4]


# --------------------------------------------------------------------------------------- the steps
def _steps_for(goal: str, ctx: Dict[str, Any]) -> Dict[str, Any]:
    from .lookup import how_to
    from .point import _steps

    found = how_to(str(ctx.get("app") or ""), goal)
    if not found.get("ok"):
        return found
    steps = _steps(str(found.get("steps") or ""))
    if not steps:
        return {"ok": False, "error": "The help page's steps couldn't be read."}
    return {"ok": True, "steps": steps, "source": found.get("source")}


def _private() -> bool:
    try:
        from . import ui_state

        return ui_state.load().get("mode") == "private"
    except Exception:
        return False


_RISKY = re.compile(r"\b(delete|remove|erase|send|pay|buy|purchase|order|post|publish|submit|sign out|log out|"
                    r"unsubscribe|format|reset|uninstall|discard)\b", re.I)
_walk_lock = threading.Lock()
_walk_id = 0


def guide(goal: str, app: str = "") -> Dict[str, Any]:
    """Ring the next control, look again after each click, until they're there (navigator.py)."""
    from . import navigator

    return navigator.start(goal, "guide", screen_context(app), _private())


def do(goal: str, app: str = "") -> Dict[str, Any]:
    """Click through to the goal, deciding each step by looking (navigator.py)."""
    from . import navigator

    return navigator.start(goal, "do", screen_context(app), _private())


def guide_fixed_steps(goal: str, app: str = "") -> Dict[str, Any]:
    """Ring each step on screen in turn; the next appears when they click the ringed one."""
    global _walk_id
    ctx = screen_context(app)
    if _private():
        return {"ok": False, "error": "Private mode is on, so I can't look the steps up online.",
                "on_screen": describe(ctx)}
    plan = _steps_for(goal, ctx)
    if not plan.get("ok"):
        return {**plan, "on_screen": describe(ctx)}
    steps = plan["steps"]
    if os.environ.get("VYRSE_ONSCREEN_DRY"):
        return {"ok": True, "dry_run": True, "on_screen": describe(ctx), "steps": [s["target"] for s in steps]}
    surface = Surface(ctx)
    first = _find_with_retry(surface, steps[0])
    if not first:
        return {"ok": False, "on_screen": describe(ctx), "source": plan.get("source"),
                "steps": [s["target"] for s in steps],
                "error": f"Step 1 ('{steps[0]['target']}') isn't visible on screen right now."}
    with _walk_lock:
        _walk_id += 1
        me = _walk_id
    _next.clear()
    surface.ring(first, steps[0]["caption"] or steps[0]["target"], f"Step 1 / {len(steps)}")
    threading.Thread(target=contextvars.copy_context().run, args=(_walk, surface, steps, me), daemon=True, name="vyrse-guide").start()
    return {"ok": True, "on_screen": describe(ctx), "steps": [s["target"] for s in steps if not _just_info(s)],
            "after": [s["caption"] or s["target"] for s in steps if _just_info(s)], "source": plan.get("source"),
            "note": "Step 1 is ringed on screen; clicking it brings the next (or they can say 'next'). Reply in "
                    "one or two short sentences (what you're showing them, and that you found the steps on that page)."}


def _find_with_retry(surface: Surface, step: Dict[str, str], tries: int = 3) -> Optional[Dict[str, Any]]:
    for attempt in range(tries):
        found = surface.find(step["target"], step.get("caption", ""))
        if found:
            return found
        if attempt < tries - 1:
            time.sleep(1.2)  # a menu or dialog may still be opening
    return None


def _just_info(step: Dict[str, str]) -> bool:
    """A step that's advice rather than a control to press (help pages end with 'Locate the newly created PDF')."""
    label = step["target"]
    return len(label.split()) > 5 or bool(re.match(r"(locate|find|wait|check|open the (?:file|folder)|your )", label, re.I))


def _tell(text: str) -> None:
    """A note in VYRSE (a walkthrough step it can't find): said, not guessed around."""
    try:
        from tools import desktop_ui

        desktop_ui.emit("vyrse.ui", {"action": "notify", "text": text[:200]})
    except Exception:
        pass


_next = threading.Event()  # "next" from the user (vyrse_point action=next)


def next_step() -> bool:
    """Move a running walkthrough on (they said "next" / "done" / "step 2")."""
    from . import navigator

    if navigator.say_next():
        return True
    if not _active.is_set():
        return False
    if time.monotonic() - _advanced_at[0] > 4:  # one "next" per step, however many times the model says it
        _next.set()
    return True


_advanced_at = [0.0]


_active = threading.Event()  # a walkthrough is running


def _wait_for_step(surface: Surface, nxt: Optional[Dict[str, str]], me: int, limit: float = 120) -> bool:
    """Until they click the ring, say "next", or the next step's control shows up on screen (their click opened
    it: the surest sign, whatever happened to the click signal). False when they stopped following along."""
    seen_before, print_before = surface.quick_state(nxt["target"], nxt.get("caption", "")) if nxt else (True, "")
    end = time.monotonic() + limit
    last_check = time.monotonic()
    while time.monotonic() < end:
        if me != _walk_id:
            return False
        if surface.clicked():
            return True
        if nxt and time.monotonic() - last_check > 2.0:
            last_check = time.monotonic()
            seen, print_now = surface.quick_state(nxt["target"], nxt.get("caption", ""))
            # it showed up, or (already somewhere on the page) the page changed under it: their click opened it
            if seen and (not seen_before or (print_before and print_now != print_before)):
                logger.info("vyrse: guide: next step %r is on screen now, moving on", nxt["target"])
                return True
        time.sleep(0.25)
    return False


def _walk(surface: Surface, steps: List[Dict[str, str]], me: int) -> None:
    n = len(steps)
    _active.set()
    try:
        i = 0
        while i < n - 1:
            nxt = next((s for s in steps[i + 1:] if not _just_info(s)), None)
            if not _wait_for_step(surface, nxt, me):
                break
            _next.clear()
            _advanced_at[0] = time.monotonic()
            if nxt is None:
                break
            i = steps.index(nxt)
            time.sleep(0.6)
            found = _find_with_retry(surface, nxt, tries=4)
            if not found:
                logger.info("vyrse: guide step %s (%r) not found", i + 1, nxt["target"])
                _tell(f"Step {i + 1} of {n}: I can't see '{nxt['target']}' on screen. "
                      f"{nxt.get('caption') or ''} (Help pages are sometimes behind the app.)")
                break
            surface.ring(found, nxt["caption"] or nxt["target"], f"Step {i + 1} / {n}")
        else:
            _wait_for_step(surface, None, me, limit=60)  # the last ring stays until it's clicked
    finally:
        if me == _walk_id:
            surface.clear()
            _active.clear()
            _next.clear()


def do_fixed_steps(goal: str, app: str = "") -> Dict[str, Any]:
    """Click through the looked-up steps; stop at the first one that isn't on screen (and say which)."""
    ctx = screen_context(app)
    if _private():
        return {"ok": False, "error": "Private mode is on, so I can't look the steps up online.", "on_screen": describe(ctx)}
    plan = _steps_for(goal, ctx)
    if not plan.get("ok"):
        return {**plan, "on_screen": describe(ctx)}
    steps = plan["steps"]
    if os.environ.get("VYRSE_ONSCREEN_DRY"):  # tests of the model's routing: never touch the real screen
        return {"ok": True, "dry_run": True, "on_screen": describe(ctx), "steps": [s["target"] for s in steps]}
    surface = Surface(ctx)
    done: List[str] = []
    for i, step in enumerate(steps):
        if i:
            time.sleep(1.2)
        if done and _just_info(step):
            continue  # "locate the downloaded file": advice, not a button; never click for it
        found = _find_with_retry(surface, step)
        if not found:
            return {"ok": False, "on_screen": describe(ctx), "done": done, "source": plan.get("source"),
                    "stopped_at": f"Step {i + 1}: '{step['target']}' isn't on screen.",
                    "remaining": [s["target"] for s in steps[i:]],
                    "note": "Tell them how far you got and offer to ring the rest (vyrse_point action=guide)."}
        name = str(found.get("name") or step["target"])
        if _RISKY.search(f"{name} {step['target']}"):
            from .confirm import ask

            if ask(f"Click '{name}'?", ["Yes, click it", "No"]) != "Yes, click it":
                return {"ok": False, "done": done, "stopped_at": f"They didn't want me to click '{name}'."}
        try:
            surface.click(found)
        except Exception as exc:
            return {"ok": False, "done": done, "stopped_at": f"Step {i + 1} ('{name}') couldn't be clicked: {exc}"}
        done.append(name)
    return {"ok": True, "on_screen": describe(ctx), "done": done, "source": plan.get("source"),
            "note": "All steps clicked. Say what you did in one sentence; if a dialog or download should have "
                    "appeared, tell them where to look."}


# --------------------------------------------------------------------------------------- routing hint
_ONSCREEN = re.compile(
    r"\b(highlight|mark|point (?:at|to|out)|show me (?:where|how)|where (?:do|should|can|to) i (?:click|find|go)|"
    r"where(?:'s| is) the|how (?:do|can) i\b.*\b(?:in|on) (?:this|here|it|chrome|word|excel)|walk me through|"
    r"guide me|do it (?:for me|on (?:your|ur) own|urself|yourself)|(?:show|point|click|find) (?:\w+ )?on (?:my|the) screen|controlling my screen|"
    r"(?:export|save|download|convert) (?:this|it)\b)", re.I)
_DO = re.compile(r"\b(do it|do that|for me|on (?:your|ur) own|yourself|urself|right away|controlling|click it|"
                 r"just (?:do|export|save|download))\b", re.I)


_AGAIN = re.compile(r"\b(?:didn'?t|did not|can'?t|cannot|don'?t|do not) see\b|not (?:showing|visible|there)|"
                    r"show (?:it|me|that) again|where (?:is it|'?s it)|highlight it|i want (?:you|u) to highlight", re.I)
_NEXT_SAID = re.compile(r"\b(next|step \d|done|clicked|didn'?t (?:work|show|come)|nothing (?:happened|came)|now what|then what|what now)\b", re.I)


def wants_onscreen(text: str) -> Optional[str]:
    """'guide' or 'do' when the message is about doing something in what's on screen, else None."""
    if not _ONSCREEN.search(text or ""):
        return None
    return "do" if _DO.search(text) else "guide"


def pre_llm_call(platform: str = "", user_message: Any = "", **_: Any) -> Optional[Dict[str, str]]:
    """Point a small model straight at the one tool that does on-screen jobs, and say what's on screen."""
    text = str(user_message or "")
    if platform != "vyrse" or text.lstrip().startswith("[") or len(text) > 600:
        return None
    from . import navigator

    if navigator.active.is_set() and _AGAIN.search(text):
        return {"context": "[A walkthrough is on screen and they can't see the ring: call vyrse_point action=again "
                           "(it draws the current step again). Don't start a new guide.]"}
    if (_active.is_set() or navigator.active.is_set()) and _NEXT_SAID.search(text):
        return {"context": "[A walkthrough is on screen. They want the next step: call vyrse_point action=next.]"}
    mode = wants_onscreen(text)
    if not mode:
        return None
    try:
        ctx = screen_context()
        where = describe(ctx)
    except Exception:
        where = "their screen"
    verb = ("click through it yourself: vyrse_point action=do" if mode == "do"
            else "ring each step on screen for them: vyrse_point action=guide")
    return {"context": (
        f"[On screen right now: {where}. This is an on-screen task: {verb} goal='<what they want, in a few words>'. "
        "That one call finds the app, looks up the real steps and handles the screen; don't use the terminal, "
        "files or other tools for it, and don't list steps from memory.]")}
