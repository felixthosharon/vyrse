import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin

from vyrse.housekeeping import WARMUP_PROMPT, leftover_ids  # noqa: E402

NOW = 1_800_000_000.0
OLD = NOW - 3600
NEW = NOW - 60


def make_db(tmp_path):
    path = tmp_path / "state.db"
    db = sqlite3.connect(path)
    db.execute("create table sessions (id text, source text, title text, hidden int, message_count int, started_at real)")
    db.execute("create table messages (session_id text, role text, content text)")
    rows = [
        ("warm-old", "vyrse", "Ready", 1, 2, OLD, [("user", WARMUP_PROMPT), ("assistant", "ready")]),
        ("warm-new", "vyrse", "Ready", 1, 2, NEW, [("user", WARMUP_PROMPT)]),
        ("ghost", "unknown", "Ready", 0, 0, OLD, []),
        ("real", "vyrse", "Graph CPU", 0, 4, OLD, [("user", "Graph my CPU"), ("assistant", "ok")]),
        ("hidden-real", "vyrse", None, 1, 2, OLD, [("user", WARMUP_PROMPT), ("user", "something else")]),
        ("cli", "cli", None, 0, 0, OLD, []),
    ]
    for sid, source, title, hidden, count, started, messages in rows:
        db.execute("insert into sessions values (?,?,?,?,?,?)", (sid, source, title, hidden, count, started))
        db.executemany("insert into messages values (?,?,?)", [(sid, r, c) for r, c in messages])
    db.commit()
    db.close()
    return path


def test_only_old_warmups_and_empty_ghosts(tmp_path):
    assert sorted(leftover_ids(make_db(tmp_path), now=NOW)) == ["ghost", "warm-old"]
