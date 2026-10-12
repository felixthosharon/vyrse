"""Startup housekeeping for VYRSE's own leftovers in Hermes' session store.

- Hidden warm-up sessions (VYRSE's "Reply with exactly: ready" prompt-cache primer) older than 10 minutes.
- Empty, sourceless rows Hermes' title writer re-created for a session deleted before it finished
  ("Ready" in history). They hold no messages.
Runs once, in the backend VYRSE spawned, a little after startup. Never touches a session with real
messages or a non-VYRSE warm-up.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

logger = logging.getLogger(__name__)
WARMUP_PROMPT = "Reply with exactly: ready"
_started = False


def start(delay_s: float = 20.0) -> None:
    global _started
    if _started or not os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN"):
        return
    _started = True

    def run() -> None:
        time.sleep(delay_s)
        try:
            removed = purge()
            if removed:
                logger.info("vyrse: removed %d leftover warm-up/empty sessions", removed)
        except Exception:
            logger.exception("vyrse: session housekeeping failed")

    threading.Thread(target=run, daemon=True, name="vyrse-housekeeping").start()


def leftover_ids(db_path: Path, now: float | None = None) -> list[str]:
    cutoff = (now or time.time()) - 600
    with sqlite3.connect(str(db_path), timeout=10) as db:
        warmups = db.execute(
            """select s.id from sessions s
               where s.hidden = 1 and s.started_at < ? and coalesce(s.message_count, 0) <= 2
                 and exists (select 1 from messages m where m.session_id = s.id and m.role = 'user' and m.content = ?)
                 and not exists (select 1 from messages m where m.session_id = s.id and m.role = 'user' and m.content != ?)""",
            (cutoff, WARMUP_PROMPT, WARMUP_PROMPT),
        ).fetchall()
        ghosts = db.execute(
            """select s.id from sessions s
               where coalesce(s.source, 'unknown') = 'unknown' and s.started_at < ?
                 and not exists (select 1 from messages m where m.session_id = s.id)""",
            (cutoff,),
        ).fetchall()
    return [r[0] for r in warmups + ghosts]


def purge() -> int:
    from hermes_constants import get_hermes_home
    from hermes_state import SessionDB

    home = Path(get_hermes_home())
    db_path = home / "state.db"
    ids = leftover_ids(db_path)
    if not ids:
        return 0
    store = SessionDB(db_path)
    removed = 0
    for sid in ids:
        try:
            removed += bool(store.delete_session(sid, sessions_dir=home / "sessions", exclude_active_write_guards=True))
        except Exception as exc:  # an active session or a locked row: leave it for next time
            logger.debug("vyrse: kept session %s: %s", sid, exc)
    return removed
