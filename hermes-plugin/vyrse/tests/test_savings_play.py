"""Savings in chat (same maths as Settings) and what "play X on Spotify" searches for."""
import json
import sqlite3
import time


def _db(path):
    db = sqlite3.connect(str(path))
    db.executescript(
        """create table sessions (id text, model text, billing_provider text, started_at real, input_tokens int,
                                  output_tokens int, cache_read_tokens int, estimated_cost_usd real,
                                  actual_cost_usd real, api_call_count int);
           create table session_model_usage (session_id text, model text, task text, billing_provider text,
                                             input_tokens int, output_tokens int, cache_read_tokens int,
                                             estimated_cost_usd real, api_call_count int);""")
    now = time.time()
    rows = [
        ("a", "qwen", "custom", now - 3600, 900_000, 50_000, 100_000, 0, 0, 10),       # local: $3 + $0.75
        ("b", "qwen", "", now - 2 * 86400, 0, 0, 0, 0, 0, 0),                          # empty: ignored
        ("c", "gpt", "openrouter", now - 86400, 10_000, 1_000, 0, 0.05, 0.07, 2),     # online: charged $0.07
        ("d", "qwen", "custom", now - 40 * 86400, 1_000_000, 0, 0, 0, 0, 5),          # outside 30 days
    ]
    db.executemany("insert into sessions values (?,?,?,?,?,?,?,?,?,?)", rows)
    db.execute("insert into session_model_usage values ('a','qwen','vision','custom',100000,0,0,0,1)")  # +$0.30
    db.commit()
    db.close()


def test_savings_match_the_settings_page(tmp_path):
    from vyrse import savings

    path = tmp_path / "state.db"
    _db(path)
    rep = savings.summary(30, db_path=path)
    assert rep["ok"] and rep["saved_usd"] == 4.05 and rep["paid_usd"] == 0.07
    assert rep["models"][0] == {"model": "qwen", "on_this_pc": True, "tokens": 1_150_000, "saved_usd": 4.05}
    assert savings.summary(365, db_path=path)["saved_usd"] == 7.05
    assert not savings.summary(30, db_path=tmp_path / "missing.db")["ok"]


def test_system_tool_answers_savings(tmp_path, monkeypatch):
    from vyrse import savings, system

    _db(tmp_path / "state.db")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(system, "_show", lambda payload: payload)
    out = json.loads(system.handle({"action": "savings", "days": 7}))
    assert out["saved_usd"] == 4.05 and out["days"] == 7
    assert out["workspace"]["items"][0] == {"label": "Saved", "value": "$4.05"}
    assert savings.would_have_cost(1_000_000, 1_000_000) == 18


def test_play_searches_for_what_was_asked(monkeypatch):
    from vyrse import controls

    assert controls.play_query("lofi on Spotify") == "lofi"
    assert controls.play_query("some lofi") == "lofi"
    assert controls.play_query("a song called Blinding Lights") == "Blinding Lights"
    assert controls.play_query("songs by Drake on spotify.") == "Drake"
    seen = {}
    monkeypatch.setattr(controls, "run", lambda req, timeout=20, script=None: seen.update(req=req, script=script) or {"ok": True, "title": "x"})
    assert json.loads(controls.handle({"action": "play", "query": "chill beats on spotify"}))["ok"]
    assert seen["req"] == {"query": "chill beats"} and seen["script"].name == "spotify.ps1"
    assert not json.loads(controls.handle({"action": "play", "query": " on spotify"}))["ok"]
