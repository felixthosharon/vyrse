"""Clipboard memory: the last few hundred bits of TEXT the user copied, on this PC, so VYRSE can answer "paste the
link I copied this morning" or "what was that address I copied?".

Never kept: anything copied while a password manager is in front, anything that looks like a password, one-time
code, key or token, anything copied in private mode, and nothing at all when the user turns it off
(Settings -> Assistant -> "Clipboard memory"). Stored in %HERMES_HOME%/vyrse/clipboard.db.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)
KEEP = 300
TICK = 1.5
PASSWORD_APPS = re.compile(r"1password|bitwarden|keepass|lastpass|dashlane|keeper|nordpass|roboform|enpass|proton ?pass|authy|authenticator", re.I)
SECRETS = [
    re.compile(r"^\d{4,8}$"),  # one-time codes
    re.compile(r"^(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA|AIza|ya29\.|eyJ)[\w.\-]{12,}$"),  # keys and tokens
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]
_started = False


def _card_number(text: str) -> bool:
    """13-19 digits (spaces/dashes allowed) that pass the Luhn check: a payment card number."""
    if not re.fullmatch(r"[\d \-]{13,23}", text):
        return False
    digits = [int(c) for c in text if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def looks_secret(text: str) -> bool:
    t = text.strip()
    if any(p.search(t) for p in SECRETS) or _card_number(t):
        return True
    # a single "word" mixing letters, digits and symbols, password-length: treat as a password
    if " " not in t and 8 <= len(t) <= 64 and not t.startswith(("http://", "https://", "www.")) and "@" not in t[1:-4]:
        kinds = sum(bool(re.search(p, t)) for p in (r"[a-z]", r"[A-Z]", r"\d", r"[^\w]"))
        if kinds >= 3 and not re.fullmatch(r"[\w.\-]+\.[a-z]{2,4}", t):  # file names like report_v2.pdf are fine
            return True
    return False


def _db() -> sqlite3.Connection:
    home = Path(os.environ.get("HERMES_HOME") or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "hermes")
    (home / "vyrse").mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(home / "vyrse" / "clipboard.db"), timeout=10, check_same_thread=False)
    db.execute("create table if not exists clips (id integer primary key, ts real, text text, app text)")
    return db


def enabled() -> bool:
    try:
        from . import ui_state

        prefs = ui_state.load()
        return prefs.get("clipboardMemory", True) and prefs.get("mode") != "private"
    except Exception:
        return True


def _read_text() -> Optional[str]:
    CF_UNICODETEXT = 13
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.GetClipboardData.restype = wt.HANDLE
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [wt.HGLOBAL]
    kernel32.GlobalUnlock.argtypes = [wt.HGLOBAL]
    if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
        return None
    for _ in range(3):  # another app may hold the clipboard for a moment
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        return None
    try:
        h = user32.GetClipboardData(CF_UNICODETEXT)
        if not h:
            return None
        p = kernel32.GlobalLock(h)
        try:
            return ctypes.wstring_at(p) if p else None
        finally:
            kernel32.GlobalUnlock(h)
    finally:
        user32.CloseClipboard()


def remember(text: str, app: str, now: Optional[float] = None) -> bool:
    """Keep one copy (unless it's a secret or the same as the last one). Returns whether it was kept."""
    text = (text or "").strip()
    if not text or len(text) > 20000 or looks_secret(text) or PASSWORD_APPS.search(app or ""):
        return False
    db = _db()
    last = db.execute("select text from clips order by id desc limit 1").fetchone()
    if last and last[0] == text[:4000]:
        db.close()
        return False
    db.execute("insert into clips (ts, text, app) values (?, ?, ?)", (now or time.time(), text[:4000], (app or "")[:60]))
    db.execute("delete from clips where id not in (select id from clips order by id desc limit ?)", (KEEP,))
    db.commit()
    db.close()
    return True


def start() -> None:
    global _started
    if _started or os.name != "nt" or not os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN"):
        return
    _started = True

    def run() -> None:
        from .usage import _foreground, friendly

        seq = ctypes.windll.user32.GetClipboardSequenceNumber()
        while True:
            time.sleep(TICK)
            try:
                now = ctypes.windll.user32.GetClipboardSequenceNumber()
                if now == seq:
                    continue
                seq = now
                if not enabled():
                    continue
                fg = _foreground()
                app = friendly(*fg) if fg else ""
                if fg and PASSWORD_APPS.search(f"{fg[0]} {fg[1]}"):
                    continue
                text = _read_text()
                if text:
                    remember(text, app)
            except Exception:
                logger.debug("vyrse: clipboard memory tick failed", exc_info=True)

    threading.Thread(target=run, daemon=True, name="vyrse-clipboard").start()


def history(query: str = "", limit: int = 10, since_hours: Optional[float] = None) -> Dict[str, Any]:
    db = _db()
    where, args = [], []
    for w in [w for w in re.split(r"\s+", (query or "").strip()) if w][:5]:
        where.append("lower(text) like ?")
        args.append(f"%{w.lower()}%")
    if since_hours:
        where.append("ts >= ?")
        args.append(time.time() - since_hours * 3600)
    rows = db.execute(f"select ts, text, app from clips {('where ' + ' and '.join(where)) if where else ''} order by id desc limit ?",
                      args + [max(1, min(30, int(limit or 10)))]).fetchall()
    db.close()
    items: List[Dict[str, Any]] = [{"copied": time.strftime("%a %H:%M", time.localtime(ts)), "from": app or "?",
                                    "text": t if len(t) <= 400 else t[:400] + "…"} for ts, t, app in rows]
    return {"ok": True, "count": len(items), "clips": items,
            "note": "Newest first. To paste one back, put it on the clipboard with vyrse_controls action=clipboard_set."}


def forget_all() -> Dict[str, Any]:
    db = _db()
    db.execute("delete from clips")
    db.commit()
    db.close()
    return {"ok": True, "forgotten": True}
