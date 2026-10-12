import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin

from vyrse import briefing, log  # noqa: E402


def test_log_add_totals_and_card(tmp_path, monkeypatch):
    import hermes_constants
    from vyrse import tools, workspace

    shown = []
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: str(tmp_path))
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True)
    monkeypatch.setattr(workspace, "deliver", lambda payload, **kw: shown.append(payload) or True)
    for entry, mins in (("physics", 45), ("maths", 30)):
        assert json.loads(log.handle({"action": "add", "log": "Study", "entry": entry, "value": mins, "unit": "min"}))["success"]
    res = json.loads(log.handle({"action": "add", "log": "study", "entry": "chemistry", "value": "20 min"}))
    assert "Today: 95 min (3 entries)" in res["result"]
    card = shown[-1]["artifact"]
    assert card["id"] == "log-study" and card["kind"] == "log"
    info = card["log"]
    assert (info["today"], info["unit"], info["streak"], info["fresh"]) == (95.0, "min", 1, True)
    assert info["entries"][0]["label"] == "chemistry" and info["days"][-1] == {"label": "Today", "value": 95.0}
    assert (tmp_path / "vyrse" / "logs" / "study.csv").read_text(encoding="utf-8").startswith("time,entry,value,unit")
    res = json.loads(log.handle({"action": "undo", "log": "study"}))
    assert "Today: 75 min" in res["result"]
    assert json.loads(log.handle({"action": "list"}))["logs"] == ["study"]
    assert not json.loads(log.handle({"action": "show", "log": "nothing"}))["success"]


def test_log_without_amounts_counts_entries():
    now = datetime(2026, 10, 11, 12, 0)
    rows = [{"time": now - timedelta(days=d), "entry": "water", "value": None, "unit": ""} for d in (0, 0, 1, 3)]
    info = log.summary("water", rows, now=now)
    assert (info["today"], info["unit"], info["week"], info["streak"]) == (2.0, "entries", 4.0, 2)


def test_briefing_cards():
    card = briefing.cards({"part_of_day": "morning", "local_time": "Saturday 11 October, 07:30",
                           "weather": {"place": "London", "now": "Light rain", "temp_c": "13", "high_c": "15", "low_c": "9", "max_chance_of_rain": 80},
                           "reminders_today": [{"at": "10:00", "name": "Physics quiz"}],
                           "headlines": [{"title": "New GPU drivers are out", "source": "x"}], "pc_attention": []})
    assert card["kind"] == "cards" and card["id"] == "briefing"
    assert card["cards"][0] == {"label": "Weather · London", "value": "13°", "detail": "Light rain · H 15° · L 9° · 80% rain", "icon": "rain"}
    assert [c["label"] for c in card["cards"]] == ["Weather · London", "Today", "Headlines", "Your PC"]
    assert card["cards"][3]["detail"] == "All good"


def test_past_days_units_and_real_totals(tmp_path, monkeypatch):
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: str(tmp_path))
    add = lambda **kw: json.loads(log.handle({"action": "add", **kw}))  # noqa: E731
    res = add(log="study", entry="chemistry", value=20, unit="minutes")
    # The reply example carries the real total (it used to say "95 minutes" whatever the total was).
    assert "That's **20 min** today" in res["result"]
    assert "60 min" in add(log="study", entry="maths", value=1, unit="h")["result"]
    bad = add(log="study", entry="3 chapters", value=3)
    assert not bad["success"] and "kept in min" in bad["error"] and "rings" in bad["error"]
    for n, hours in enumerate([6, 5, 7], start=1):
        assert add(log="sleep", value=hours, unit="h", when=f"{n} days ago")["success"]
    info = log.summary("sleep", log.read("sleep"))
    assert info["today"] == 0 and info["week"] == 18
    assert not add(log="sleep", value=8, unit="h", when="next tuesday")["success"]
    assert log._when("yesterday", datetime(2026, 10, 12, 9)).date().isoformat() == "2026-10-11"
    assert log._when("monday", datetime(2026, 10, 12, 9)).date().isoformat() == "2026-10-05"
