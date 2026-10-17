"""`vyrse_chrome`: use the user's own Chrome (their everyday profile, logins and tabs), not a separate browser.

The VYRSE extension (repo `chrome-extension/`, installed copy in %HERMES_HOME%/vyrse/chrome-extension) connects
to a WebSocket server here on 127.0.0.1:18492. Only an extension origin holding this PC's token is accepted.
Commands run in the active tab: read the page (text + numbered controls, icon-only ones included), click, type,
keys, scroll, tabs, and a ring on an element for "show me where". When the model names a control by description
("the bell icon"), the page's controls are numbered on a screenshot and the vision model picks one (see.py), or
says none.
"""
from __future__ import annotations

import base64
import hmac
import itertools
import json
import logging
import re
import secrets
import shutil
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus, urlparse

logger = logging.getLogger(__name__)

PORT = 18492
_SOURCE = Path(__file__).resolve().parents[2] / "chrome-extension"

_lock = threading.Lock()
_conn = None
_pending: Dict[int, Dict[str, Any]] = {}
_ids = itertools.count(1)
_server_started = False
_state: Dict[str, Any] = {"running": "", "told": ""}
ring_clicked = threading.Event()


def _installed_version() -> str:
    try:
        return str(json.loads((extension_dir() / "manifest.json").read_text(encoding="utf-8")).get("version") or "")
    except (OSError, ValueError):
        return ""

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_chrome",
    "description": (
        "Use the user's OWN Chrome (their normal profile: logged-in sites, open tabs). Use this for anything in "
        "Chrome or on a website. It acts in the tab they're on unless you pass tab. Actions: tabs (list); open "
        "(url, new tab); search (query: a Google search in a new tab, also for looking up how to do something); go "
        "(url, same tab); switch (tab); close (tab); back; forward; reload; read (the page's text and its numbered "
        "controls [n], icon buttons included); click (ref = [n] from read, or target = the control's label or what "
        "it looks like, e.g. 'the bell icon', 'Subscribe'); type (text, plus ref or target of the field; submit=true "
        "presses Enter); keys (e.g. ctrl+l, escape, pagedown); scroll (direction up/down/top/bottom); point (target, "
        "caption: a glowing ring on it, nothing clicked: for 'show me where'); look (question: look at the visible "
        "page and answer, e.g. what's in this chart). Read before acting on a page you haven't read, and read again "
        "after it changes. Never invent page content: report what read/look returned."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["tabs", "open", "search", "go", "switch", "close", "back", "forward",
                                                   "reload", "read", "click", "type", "keys", "scroll", "point", "look"]},
            "url": {"type": "string"},
            "query": {"type": "string", "description": "search: what to search for."},
            "tab": {"type": "integer", "description": "Tab id from tabs (default: the tab they're on)."},
            "ref": {"type": "integer", "description": "A control's [n] from the last read."},
            "target": {"type": "string", "description": "click/type/point: the control's label or a description of it."},
            "text": {"type": "string", "description": "type: the text."},
            "submit": {"type": "boolean", "description": "type: press Enter after."},
            "keys": {"type": "string"},
            "direction": {"type": "string", "enum": ["up", "down", "top", "bottom"]},
            "caption": {"type": "string", "description": "point: what to do with it, a few words."},
            "question": {"type": "string", "description": "look: what to find out from the page."},
        },
        "required": ["action"],
    },
}


# ------------------------------------------------------------------------------------------ install + server
def _home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "vyrse"


def token() -> str:
    path = _home() / "chrome" / "token"
    try:
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    value = secrets.token_urlsafe(32)
    path.write_text(value, encoding="utf-8")
    return value


def extension_dir() -> Path:
    return _home() / "chrome-extension"


def install_extension() -> Optional[Path]:
    """Keep the installed copy (what Chrome loads, unpacked) in step with the repo, with this PC's config.js."""
    if not (_SOURCE / "manifest.json").is_file():
        return None
    dest = extension_dir()
    try:
        for src in _SOURCE.rglob("*"):
            if src.is_dir() or src.name == "config.js":
                continue
            out = dest / src.relative_to(_SOURCE)
            if not out.exists() or out.read_bytes() != src.read_bytes():
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, out)
        config = f"// Written by VYRSE for this PC. Keep it private.\nexport const CONFIG = {{ port: {PORT}, token: {json.dumps(token())} }}\n"
        cfg = dest / "config.js"
        if not cfg.exists() or cfg.read_text(encoding="utf-8") != config:
            cfg.write_text(config, encoding="utf-8")
        return dest
    except OSError as exc:
        logger.warning("vyrse: couldn't install the Chrome extension files: %s", exc)
        return None


def _serve(conn) -> None:
    global _conn
    origin = str(conn.request.headers.get("Origin") or "")
    if not origin.startswith("chrome-extension://"):
        conn.close(1008, "not an extension")
        return
    try:
        hello = json.loads(conn.recv(timeout=10))
    except Exception:
        conn.close(1008, "no hello")
        return
    if hello.get("type") != "hello" or not hmac.compare_digest(str(hello.get("token") or ""), token()):
        conn.close(1008, "bad token")
        return
    with _lock:
        old, _conn = _conn, conn
    wanted = _installed_version()
    conn.send(json.dumps({"type": "welcome", "latest": wanted}))
    running = str(hello.get("version") or "")
    _state["running"] = running
    if wanted and running != wanted:
        # Chrome runs an older copy than the one installed. Asking it to reload itself (chrome.runtime.reload)
        # unloads an unpacked extension for good, so the user is asked, once, to press its reload button.
        logger.info("vyrse: Chrome extension v%s is out of date (v%s installed)", running, wanted)
    if old is not None and old is not conn:
        try:
            old.close()
        except Exception:
            pass
    logger.info("vyrse: Chrome extension connected (%s, v%s)", origin, hello.get("version"))
    try:
        for raw in conn:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if msg.get("type") == "result":
                waiter = _pending.get(int(msg.get("id") or 0))
                if waiter is not None:
                    waiter["reply"] = msg
                    waiter["event"].set()
            elif msg.get("type") == "event" and msg.get("name") == "ring_clicked":
                ring_clicked.set()  # the user clicked what was ringed (a walkthrough moves on)
    except Exception:
        pass
    finally:
        with _lock:
            if _conn is conn:
                _conn = None
        logger.info("vyrse: Chrome extension disconnected")


def start_server() -> bool:
    """Listen for the extension (once per process; a second Hermes process just finds the port taken)."""
    global _server_started
    if _server_started:
        return True
    with _lock:
        if _server_started:
            return True
        _server_started = True
    try:
        from websockets.sync.server import serve

        server = serve(_serve, "127.0.0.1", PORT, origins=[re.compile(r"chrome-extension://[a-p]{32}")],
                       max_size=64 * 1024 * 1024, ping_interval=20, ping_timeout=20, compression=None)
    except OSError as exc:
        logger.info("vyrse: Chrome bridge not started here (%s)", exc)
        return False
    except Exception as exc:
        logger.warning("vyrse: Chrome bridge failed to start: %s", exc)
        return False
    threading.Thread(target=server.serve_forever, daemon=True, name="vyrse-chrome-bridge").start()
    logger.info("vyrse: Chrome bridge listening on 127.0.0.1:%s", PORT)
    return True


def setup() -> None:
    """At plugin load in the VYRSE backend (hermes serve): install the extension files and start listening."""
    install_extension()
    if any(arg == "serve" for arg in sys.argv[1:4]):
        start_server()


def connected() -> bool:
    return _conn is not None


def update_note() -> str:
    """Once per new version: a line for the model to pass on when Chrome runs an out-of-date extension."""
    wanted = _installed_version()
    if not connected() or not wanted or _state["running"] in ("", wanted) or _state["told"] == wanted:
        return ""
    _state["told"] = wanted
    return ("Also tell the user, in one short line: VYRSE's Chrome extension has an update; open chrome://extensions "
            "and press the reload arrow on the VYRSE card.")


def call(cmd: str, args: Optional[Dict[str, Any]] = None, timeout: float = 30) -> Dict[str, Any]:
    """Run one command in Chrome. Raises RuntimeError with a message for the model when it can't."""
    start_server()
    conn = _conn
    if conn is None:
        raise RuntimeError(
            "VYRSE's Chrome extension isn't connected. Tell the user how to add it once: open chrome://extensions, "
            "turn on Developer mode, Load unpacked, and pick the folder " + str(extension_dir()) + ". "
            "(If it's already added, Chrome may be closed.)")
    request_id = next(_ids)
    waiter = {"event": threading.Event(), "reply": None}
    _pending[request_id] = waiter
    try:
        conn.send(json.dumps({"type": "command", "id": request_id, "cmd": cmd, "args": args or {}}))
        if not waiter["event"].wait(timeout):
            raise RuntimeError("Chrome didn't answer in time.")
        reply = waiter["reply"] or {}
    finally:
        _pending.pop(request_id, None)
    if not reply.get("ok"):
        raise RuntimeError(str(reply.get("error") or "Chrome couldn't do that."))
    return reply.get("result") or {}


# --------------------------------------------------------------------------------------------- the tool
def _element_line(e: Dict[str, Any]) -> str:
    name = str(e.get("name") or "").strip()
    text = f'[{e["ref"]}] {e.get("type")} "{name}"' if name else f'[{e["ref"]}] {e.get("type")} (icon, no label)'
    if e.get("hint") and (e.get("icon") or not name):
        text += f" icon:{e['hint'][:50]}"
    if e.get("value"):
        text += f' value="{e["value"]}"'
    if "checked" in e:
        text += " (on)" if e["checked"] else " (off)"
    if e.get("disabled"):
        text += " (disabled)"
    return text


def read_page(tab: Optional[int] = None) -> Dict[str, Any]:
    snap = call("snapshot", {"tab": tab, "text": True})
    elements = snap.get("elements") or []
    note = "Controls are what's visible now; scroll to see more. Use their [n] as ref, or target to describe one."
    if len(elements) < 3:
        note = ("This page draws its own interface, so few controls are listed. That's fine: click/point/type with "
                "target = the button's label or what it looks like (e.g. target='File'); VYRSE finds it on the "
                "screenshot. Use look to ask what's on screen.")
    return {
        "ok": True, "tab": snap.get("tab"), "title": snap.get("title"), "url": snap.get("url"),
        "text": str(snap.get("text") or "")[:5000],
        "controls": "\n".join(_element_line(e) for e in elements[:150]),
        "scroll": snap.get("scroll"),
        "note": note,
    }


def _norm(text: str) -> str:
    return re.sub(r"[^\w]+", " ", str(text or "").lower()).strip()


def resolve(target: "str | List[str]", tab: Optional[int] = None) -> Dict[str, Any]:
    """The control the user means. A unique exact label straight away; otherwise the page's controls are numbered
    on a screenshot and the vision model picks one; and when the page has no usable controls (Word online, canvas
    apps), the model finds it on the screenshot itself. Each step may say none: then nothing is done."""
    # several wordings of the same thing (a step's label, its parts): one screenshot, the cheap checks for each,
    # then the vision model once with the fullest wording (the last)
    wordings = [target] if isinstance(target, str) else [t for t in target if t]
    target = wordings[-1]
    snap = call("snapshot", {"tab": tab, "image": True}, timeout=45)
    elements = [e for e in (snap.get("elements") or []) if not e.get("disabled")]
    exact: List[Dict[str, Any]] = []
    for wording in wordings:
        want = _norm(re.sub(r"^(the|a|an)\s+|\s+(button|icon|link|tab|field|box|menu)$", "", wording.strip(), flags=re.I))
        exact = [e for e in elements if _norm(e.get("name")) == want]
        if len(exact) == 1:
            return {"ok": True, "element": exact[0], "tab": snap.get("tab"), "how": "label"}
    from . import see

    png = base64.b64decode(snap.get("image") or "")
    if not png:
        return {"ok": False, "error": "Couldn't see the page."}
    dpr = float(snap.get("dpr") or 1)
    where = f"the web page '{snap.get('title')}' ({urlparse(str(snap.get('url') or '')).netloc}) in Chrome"
    css = lambda r: {k: round(v / dpr, 1) for k, v in r.items()}  # noqa: E731  image pixels -> CSS px
    # Visible text first (Windows OCR on the screenshot): pages that draw their own UI still show their words.
    lines = see.ocr_lines(png)
    for wording in wordings:
        plain = re.sub(r"^(the|a|an)\s+|\s+(button|icon|link|tab|field|box|menu|option|item)$", "", wording.strip(), flags=re.I)
        hits = see.text_hits(lines, plain)
        if len(hits) == 1:
            return {"ok": True, "rect": css(hits[0]["rect"]), "tab": snap.get("tab"), "how": "text"}
    labels: List[str] = []
    items = [{**e, "name": e.get("name") or "", "id": ""} for e in elements]
    items += [{**i, "rect": css(i["rect"])} for i in see.ocr_items(lines)]
    if items:
        choice = see.choose(png, items, target, scale=dpr, where=where)
        if choice.get("ok"):
            item = choice["item"]
            if "ref" not in item:  # a line of text on screen, not a listed control
                return {"ok": True, "rect": item["rect"], "tab": snap.get("tab"), "how": "looked"}
            return {"ok": True, "element": item, "tab": snap.get("tab"), "how": "looked", "why": choice.get("why")}
        labels = choice.get("labels") or []
    spot = see.locate_pixels(png, target, where=where)
    if spot:
        rect = {k: round(v / dpr, 1) for k, v in spot.items()}
        return {"ok": True, "rect": rect, "tab": snap.get("tab"), "how": "screenshot"}
    return {"ok": False, "error": f"I looked, and I can't see '{target}' on the page.", "labels": labels[:30]}


def _target(params: Dict[str, Any], tab: Optional[int]) -> Dict[str, Any]:
    """-> {ok, ref | rect, tab, name}. A description (target) wins over a ref: refs from an old read go stale."""
    target = str(params.get("target") or "").strip()
    if not target and params.get("ref") is not None:
        return {"ok": True, "ref": int(params["ref"]), "tab": tab, "name": f"[{params['ref']}]"}
    if not target:
        return {"ok": False, "error": "Say which control: target (its label or what it looks like) or ref ([n] from read)."}
    found = resolve(target, tab)
    if not found.get("ok"):
        return {**found, "note": "Nothing done. Don't guess: scroll or use look, then try again with what's there."}
    if "rect" in found:
        return {"ok": True, "rect": found["rect"], "tab": found.get("tab"), "name": target}
    e = found["element"]
    return {"ok": True, "ref": int(e["ref"]), "tab": found.get("tab"), "name": e.get("name") or target}


def _where(found: Dict[str, Any]) -> Dict[str, Any]:
    return {"ref": found["ref"]} if "ref" in found else {"rect": found["rect"]}


def point(params: Dict[str, Any], tab: Optional[int] = None, step: str = "", ms: int = 30000) -> Dict[str, Any]:
    """A glowing ring (and caption) on a control in the page; nothing is clicked. It goes when they click it."""
    found = _target(params, tab)
    if not found.get("ok"):
        return found
    ring_clicked.clear()
    call("highlight", {**_where(found), "caption": str(params.get("caption") or "")[:120], "tab": found.get("tab"),
                       "step": step, "ms": ms})
    return {"ok": True, "shown": found.get("name"),
            "note": "Ringed on the page (it disappears when they click it). Reply in one short sentence."}


def handle(params: Dict[str, Any], **_: Any) -> str:
    action = str(params.get("action") or "")
    tab = params.get("tab")
    tab = int(tab) if isinstance(tab, (int, float)) or (isinstance(tab, str) and tab.isdigit()) else None
    try:
        if action == "tabs":
            result: Dict[str, Any] = {"ok": True, **call("tabs")}
        elif action in ("open", "go"):
            url = str(params.get("url") or "").strip()
            if not url:
                return json.dumps({"ok": False, "error": "url is required"})
            if not re.match(r"^[a-z][\w+.-]*:", url, re.I):
                url = "https://" + url
            result = {"ok": True, **call(action, {"url": url, "tab": tab}, timeout=40)}
        elif action == "search":
            query = str(params.get("query") or params.get("text") or "").strip()
            if not query:
                return json.dumps({"ok": False, "error": "query is required"})
            result = {"ok": True, **call("open", {"url": "https://www.google.com/search?q=" + quote_plus(query)}, timeout=40)}
            result["note"] = "Search opened in a new tab. Read it to see the results; open the most useful one."
        elif action in ("switch", "close", "back", "forward", "reload"):
            if action == "switch" and tab is None:
                return json.dumps({"ok": False, "error": "tab is required (an id from action=tabs)"})
            result = {"ok": True, **call(action, {"tab": tab}, timeout=40)}
        elif action == "read":
            result = read_page(tab)
        elif action == "click":
            found = _target(params, tab)
            if not found.get("ok"):
                return json.dumps(found, ensure_ascii=False)
            result = {"ok": True, **call("click", {**_where(found), "tab": found.get("tab")}, timeout=40),
                      "note": "Clicked. Look or read again before the next step: menus and dialogs change the page."}
            if not result.get("clicked"):
                result["clicked"] = found.get("name")
        elif action == "type":
            args: Dict[str, Any] = {"text": str(params.get("text") or ""), "submit": bool(params.get("submit")), "tab": tab}
            if params.get("ref") is not None or params.get("target"):
                found = _target(params, tab)
                if not found.get("ok"):
                    return json.dumps(found, ensure_ascii=False)
                args.update(_where(found), tab=found.get("tab"))
            result = {"ok": True, **call("type", args, timeout=40)}
        elif action == "keys":
            result = {"ok": True, **call("keys", {"keys": str(params.get("keys") or ""), "tab": tab})}
        elif action == "scroll":
            result = {"ok": True, **call("scroll", {"direction": params.get("direction") or "down", "tab": tab})}
        elif action == "point":
            result = point(params, tab)
            if not result.get("ok"):
                return json.dumps(result, ensure_ascii=False)
        elif action == "look":
            question = str(params.get("question") or "What is on this page?")
            shot = call("screenshot", {"tab": tab}, timeout=30)
            from . import see

            answer = see.ask_vision(base64.b64decode(shot.get("image") or ""), (
                f"This is a screenshot of a web page in the user's Chrome. {question}\n"
                "Answer only from what is visible. If it isn't visible, say so."), max_tokens=500)
            result = {"ok": True, "answer": answer}
        else:
            return json.dumps({"ok": False, "error": f"unknown action {action!r}"})
    except RuntimeError as exc:
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    except Exception as exc:
        logger.exception("vyrse_chrome %s failed", action)
        return json.dumps({"ok": False, "error": f"Couldn't do that in Chrome: {exc}"}, ensure_ascii=False)
    note = update_note()
    if note:
        result["extension"] = note
    return json.dumps(result, ensure_ascii=False)


def block_other_browser(tool_name: str = "", **_: Any) -> Optional[Dict[str, str]]:
    """pre_tool_call: while the user's own Chrome is connected, browsing happens there, not in a separate one."""
    if not str(tool_name).startswith("browser_") or not connected():
        return None
    try:
        from .tools import _in_vyrse_session

        if not _in_vyrse_session():
            return None
    except Exception:
        return None
    return {"action": "block", "message": (
        f"{tool_name} isn't used here: VYRSE works in the user's own Chrome. Use vyrse_chrome instead (read, click, "
        "type, open, search).")}
