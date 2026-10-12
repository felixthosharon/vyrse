import base64
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin

from vyrse.workspace import build_artifact  # noqa: E402

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def test_chart_and_table_shapes():
    chart = build_artifact({"kind": "chart", "title": "CPU usage", "style": "bar", "unit": "%",
                            "points": [{"label": "0s", "value": 12}, {"label": "1s", "value": "bad"}]})
    assert chart == {"id": "cpu-usage", "title": "CPU usage", "kind": "series",
                     "series": [{"label": "0s", "value": 12.0}], "chart": {"style": "bar", "unit": "%"}}
    table = build_artifact({"kind": "table", "title": "Drives", "columns": ["Drive", "Free"], "rows": [["C:", 204]]})
    assert table["table"] == {"columns": ["Drive", "Free"], "rows": [["C:", 204]]}


def test_image_from_file_is_inlined(tmp_path):
    png = tmp_path / "graph.png"
    png.write_bytes(PNG_1PX)
    art = build_artifact({"kind": "image", "title": "Graph", "path": str(png)})
    assert art["image"]["dataUrl"].startswith("data:image/png;base64,")


def test_rejects_bad_input(tmp_path):
    with pytest.raises(ValueError):
        build_artifact({"kind": "chart", "title": "x", "points": []})
    with pytest.raises(ValueError):
        build_artifact({"kind": "image", "title": "x", "url": "http://example.com/a.png"})
    not_image = tmp_path / "notes.txt"
    not_image.write_text("hi")
    with pytest.raises(ValueError):
        build_artifact({"kind": "image", "title": "x", "path": str(not_image)})
    with pytest.raises(ValueError):
        build_artifact({"kind": "html", "title": "x"})


def test_system_sample_counts():
    pytest.importorskip("psutil")
    from vyrse import system

    result = json.loads(system.handle({"action": "sample", "metric": "memory", "seconds": 1.5, "interval": 0.5}))
    assert result["success"] and len(result["points"]) == 3
    assert {"min", "max", "avg"} <= set(result["summary"])


def test_study_kinds():
    rings = build_artifact({"kind": "rings", "title": "Goals", "items": [
        {"label": "Study", "value": 95, "max": 120, "unit": "min"}, {"label": "Water", "value": "6"}, {"label": "x"}]})
    assert rings["rings"] == [{"label": "Study", "value": 95.0, "max": 120.0, "unit": "min"},
                              {"label": "Water", "value": 6.0, "max": 100.0}]
    quiz = build_artifact({"kind": "quiz", "title": "Physics quiz", "subject": "Unit 3", "items": [
        {"question": "F = ?", "answer": "ma", "correct": True},
        {"question": "What is u?", "answer": "speed", "correct": False, "right_answer": "initial velocity"},
        {"question": "Momentum of 2 kg at 3 m/s?"}]})
    assert quiz["quiz"]["questions"][1] == {"question": "What is u?", "answer": "speed", "correct": False,
                                            "right_answer": "initial velocity"}
    assert "correct" not in quiz["quiz"]["questions"][2]
    card = build_artifact({"kind": "scorecard", "title": "Result", "score": 2, "total": 3, "verdict": "Solid. One gap.",
                           "items": [{"label": "Momentum", "value": 100}, {"label": "Motion", "value": 0.25, "weak": True}]})
    assert card["scorecard"]["topics"] == [{"label": "Momentum", "value": 1.0, "weak": False},
                                           {"label": "Motion", "value": 0.25, "weak": True}]
    checks = build_artifact({"kind": "checklist", "title": "Today", "items": [{"label": "Revise", "done": True}, {"text": "Gym"}]})
    assert checks["checklist"] == [{"label": "Revise", "done": True}, {"label": "Gym", "done": False}]
    stats = build_artifact({"kind": "stats", "title": "Week", "items": [{"label": "Study", "value": "6h 20m", "delta": "+12%"}]})
    assert stats["stats"] == [{"label": "Study", "value": "6h 20m", "change": "+12%"}]
    donut = build_artifact({"kind": "chart", "style": "donut", "title": "Disk", "points": [{"label": "Games", "value": 300}]})
    assert donut["chart"]["style"] == "donut"
    with pytest.raises(ValueError):
        build_artifact({"kind": "scorecard", "title": "x", "score": 1, "total": 0})
    with pytest.raises(ValueError):
        build_artifact({"kind": "flashcards", "title": "x", "items": [{"front": "only"}]})


def test_checklist_tick_persists(tmp_path, monkeypatch):
    import hermes_constants
    from vyrse import workspace

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: str(tmp_path))
    art = build_artifact({"kind": "checklist", "id": "todo", "title": "Today", "items": [{"label": "a"}, {"label": "b"}]})
    workspace.store_show("s1", art)
    workspace.store_check("s1", "todo", 1, True)
    assert [c["done"] for c in workspace.load_items("s1")[0]["checklist"]] == [False, True]


def test_rows_and_empty_items_from_small_models():
    # What Qwen sent when `items` had no declared fields.
    rings = build_artifact({"kind": "rings", "title": "Study", "unit": "minutes", "items": [{}, {}],
                            "rows": [["Physics", 45, 60], ["Maths", 30, 45]]})
    assert rings["rings"][0] == {"label": "Physics", "value": 45.0, "max": 60.0, "unit": "minutes"}
    checks = build_artifact({"kind": "checklist", "title": "Tonight", "rows": [["Pack bag", "false"], ["Revise", True]]})
    assert checks["checklist"] == [{"label": "Pack bag", "done": False}, {"label": "Revise", "done": True}]
    steps = build_artifact({"kind": "steps", "title": "Do", "items": ["one", "two"]})
    assert [s["label"] for s in steps["flow"]] == ["one", "two"]


def test_dashboard_kinds():
    bars = build_artifact({"kind": "chart", "style": "bar", "title": "GPU temps", "unit": "°C", "highlight": "sat",
                           "threshold": "80", "points": [{"label": "Fri", "value": 72}, {"label": "Sat", "value": 78}]})
    assert bars["chart"] == {"style": "bar", "unit": "°C", "highlight": "Sat", "threshold": 80.0}
    table = build_artifact({"kind": "table", "title": "Models", "columns": ["Model", "VRAM"], "highlight": "Qwen 9B",
                            "rows": [["Gemma 12B", "7.3 GB"], ["Qwen 9B", "5.7 GB"]]})
    assert table["table"]["highlight"] == 1
    code = build_artifact({"kind": "code", "title": "Bug", "code": "a\nb\nc", "lines": [2, "x", 2, -1]})
    assert code["code"]["highlight"] == [2]
    steps = build_artifact({"kind": "steps", "title": "Heading out", "items": [{"label": "Save work", "done": "yes"}, {"label": "Lock PC"}]})
    assert steps["flow"][0]["done"] is True and "done" not in steps["flow"][1]
    stats = build_artifact({"kind": "stats", "title": "GPU", "items": [{"label": "Temp", "value": "81°C", "trend": [72, 75, "81"]}]})
    assert stats["stats"][0]["trend"] == [72.0, 75.0, 81.0]
    gauges = build_artifact({"kind": "gauges", "title": "PC", "items": [{"label": "GPU", "value": 81, "unit": "°C", "warn": 80}, ["CPU", 34]]})
    assert gauges["gauges"] == [{"label": "GPU", "value": 81.0, "max": 100.0, "unit": "°C", "warn": 80.0},
                                {"label": "CPU", "value": 34.0, "max": 100.0}]
    cards = build_artifact({"kind": "cards", "title": "Morning", "items": [
        {"label": "Weather", "detail": "Sunny", "value": "18°", "icon": "Sun"}, {"label": "Odd", "detail": "x", "icon": "unicorn"}]})
    assert cards["cards"] == [{"label": "Weather", "detail": "Sunny", "value": "18°", "icon": "sun"}, {"label": "Odd", "detail": "x"}]
    weather = build_artifact({"kind": "weather", "title": "London", "value": 13, "condition": "Overcast", "high": 15,
                              "items": [{"at": "Mon", "label": "Rain", "value": 12}]})
    assert weather["weather"] == {"location": "London", "condition": "Overcast", "temp": 13.0, "unit": "°", "high": 15.0,
                                  "forecast": [{"at": "Mon", "label": "Rain", "value": 12.0}]}
    timer = build_artifact({"kind": "timer", "title": "Focus", "minutes": 25})
    assert timer["timer"]["seconds"] == 1500 and timer["timer"]["ends_at"] > 0
    board = build_artifact({"kind": "board", "title": "Project", "items": [
        {"label": "Design", "group": "Done"}, {"label": "Build", "group": "Doing"}, {"label": "Ship"}]})
    assert [c["name"] for c in board["board"]] == ["Done", "Doing", "To do"]
    heat = build_artifact({"kind": "heatmap", "title": "Study", "unit": "min", "items": [["2026-10-10", 40], ["2026-10-11", "x"]]})
    assert heat["heatmap"] == {"cells": [{"label": "2026-10-10", "value": 40.0}], "unit": "min"}
    app = build_artifact({"kind": "app", "title": "Tip splitter", "html": "<button>Split</button><script>1</script>"})
    assert app["app"]["html"].startswith("<button>")
    for bad in ({"kind": "timer", "title": "x", "minutes": 0}, {"kind": "app", "title": "x", "html": "plain text"},
                {"kind": "weather", "title": "x"}, {"kind": "gauges", "title": "x", "items": [{"label": "a"}]}):
        with pytest.raises(ValueError):
            build_artifact(bad)


def test_focus_action(monkeypatch):
    from vyrse import tools, workspace

    sent = []
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True)
    monkeypatch.setattr(workspace, "deliver", lambda payload, **kw: sent.append(payload) or True)
    assert json.loads(workspace.handle({"action": "focus", "id": "PC Gauges"}))["success"]
    assert sent[-1] == {"action": "workspace", "op": "focus", "id": "pc-gauges"}
    workspace.handle({"action": "show", "kind": "timer", "title": "Focus", "minutes": 25, "focus": True})
    assert sent[-1]["focus"] is True


def test_app_title_from_the_page():
    app = build_artifact({"kind": "app", "html": "<html><head><title>Tip <b>Splitter</b></title></head><body></body></html>"})
    assert app["title"] == "Tip Splitter"
    assert build_artifact({"kind": "app", "html": "<h2>Dice</h2>"})["title"] == "Dice"


def test_analysis_turns_get_the_note():
    from vyrse import workspace

    note = lambda text, platform="vyrse": workspace.pre_llm_call(platform=platform, user_message=text)  # noqa: E731
    assert note("Analyse my spending in C:/data/spending.csv")["context"] == workspace.ANALYSIS_NOTE
    assert note("what's in sales.xlsx?") and note("where does my money go?") and note("break down my screen time")
    assert note("What's 18% of 2,450?") is None and note("good morning") is None
    assert note("analyse this", platform="cli") is None


def test_stats_sent_as_a_one_row_table():
    stats = build_artifact({"kind": "stats", "title": "Spending", "columns": ["Total", "Top category"], "rows": [["₹677.48", "Games"]]})
    assert stats["stats"] == [{"label": "Total", "value": "₹677.48"}, {"label": "Top category", "value": "Games"}]


def test_stats_sent_as_points():
    stats = build_artifact({"kind": "stats", "title": "x", "points": [{"label": "Total", "value": 677.48}]})
    assert stats["stats"] == [{"label": "Total", "value": "677.48"}]


def test_picker_mindmap_and_countdown():
    pick = build_artifact({"kind": "picker", "title": "Dinner", "items": [{"label": "Pizza"}, "Tacos", {"label": "Pizza"}, {"label": "Curry"}]})
    assert pick["picker"] == {"options": ["Pizza", "Tacos", "Curry"]}
    with pytest.raises(ValueError):
        build_artifact({"kind": "picker", "title": "x", "items": [{"label": "only"}]})
    tree = build_artifact({"kind": "mindmap", "title": "Photosynthesis", "items": [
        {"label": "Light reactions", "group": "Stages"}, {"label": "Calvin cycle", "group": "Stages"},
        {"label": "Chlorophyll", "group": "Needs", "detail": "absorbs light"}, {"label": "Glucose"}]})
    assert tree["mindmap"]["center"] == "Photosynthesis"
    assert tree["mindmap"]["branches"][0] == {"label": "Stages", "leaves": [{"label": "Light reactions"}, {"label": "Calvin cycle"}]}
    assert tree["mindmap"]["branches"][2] == {"label": "Glucose", "leaves": []}
    exam = build_artifact({"kind": "timer", "title": "Physics exam", "until": (__import__("datetime").date.today() + __import__("datetime").timedelta(days=30)).isoformat()})
    assert exam["timer"]["seconds"] > 86400
    with pytest.raises(ValueError):
        build_artifact({"kind": "timer", "title": "x", "until": "2001-01-01"})


def test_turn_hints():
    from vyrse import workspace

    hint = lambda text: (workspace.pre_llm_call(platform="vyrse", user_message=text) or {}).get("context", "")  # noqa: E731
    assert "picker" in hint("I can't decide what to eat tonight, help me pick randomly.")
    assert "comparison" in hint("Which is better for me, a PS5 or a gaming PC?")
    assert "action=storage" in hint("Check what's eating my storage.")
    assert "kind=app" in hint("I keep forgetting how much tip to leave")
    assert "rings" in hint("I want to get through 3 chapters, 50 pushups and 2 litres of water today.")
    assert "donut" in hint("I spent 40 on food, 25 on uber and 60 on a game this week")
    for chat in ("Yo what's up", "Who made you?", "What's 18% of 2,450?", "What's the capital of Japan?"):
        assert hint(chat) == "", chat


def test_goal_rings_and_unlabelled_mindmap_from_qwen():
    rings = build_artifact({"kind": "rings", "title": "Today's goals",
                            "points": [{"label": "Chapters", "value": 0}, {"label": "Pushups", "value": 10}],
                            "items": [{"label": "Chapters", "value": 3}, {"label": "Pushups", "value": 50}]})
    assert [(r["value"], r["max"]) for r in rings["rings"]] == [(0.0, 3.0), (10.0, 50.0)]
    tree = build_artifact({"kind": "mindmap", "title": "Photosynthesis", "items": [
        {"detail": "Water from roots", "group": "Inputs"}, {"detail": "Glucose", "group": "Outputs"}]})
    assert tree["mindmap"]["branches"][0] == {"label": "Inputs", "leaves": [{"label": "Water from roots"}]}
    only = build_artifact({"kind": "mindmap", "title": "x", "items": [{"group": "inputs"}, {"label": "Process", "group": "process"}]})
    assert only["mindmap"]["branches"] == [{"label": "Inputs", "leaves": []}, {"label": "Process", "leaves": []}]


def test_mindmap_children():
    tree = build_artifact({"kind": "mindmap", "title": "Causes of WW1", "items": [
        {"label": "Militarism", "children": ["Arms race", "Naval race"]}, {"label": "Alliances", "children": ["Triple Entente"]}]})
    assert tree["mindmap"]["branches"] == [{"label": "Militarism", "leaves": [{"label": "Arms race"}, {"label": "Naval race"}]},
                                           {"label": "Alliances", "leaves": [{"label": "Triple Entente"}]}]


def test_mindmap_outline():
    tree = build_artifact({"kind": "mindmap", "title": "Photosynthesis",
                           "outline": "- Inputs\n  - Sunlight\n  - Water\n- **Outputs**\n    * Glucose\nFactors: light, heat"})
    assert tree["mindmap"]["branches"] == [{"label": "Inputs", "leaves": [{"label": "Sunlight"}, {"label": "Water"}]},
                                           {"label": "Outputs", "leaves": [{"label": "Glucose"}]},
                                           {"label": "Factors", "leaves": [{"label": "light"}, {"label": "heat"}]}]
    bare = build_artifact({"kind": "mindmap", "title": "WW1", "points": [{"label": "Militarism", "value": 1}]})
    assert bare["mindmap"]["branches"] == [{"label": "Militarism", "leaves": []}]


def test_flashcards_from_text():
    deck = build_artifact({"kind": "flashcards", "title": "Organic chem", "cards": "What is SN2? :: One-step substitution\n"
                                                                                   "Q: What is chirality? A: Non-superimposable mirror images"})
    assert deck["flashcards"] == [{"front": "What is SN2?", "back": "One-step substitution"},
                                  {"front": "What is chirality?", "back": "Non-superimposable mirror images"}]
    with pytest.raises(ValueError) as err:
        build_artifact({"kind": "flashcards", "title": "x", "points": [{"label": "What is SN2?", "value": 0}]})
    assert "::" in str(err.value)


def test_system_checks_draw_by_default(monkeypatch):
    from vyrse import system

    shown = []
    monkeypatch.setattr(system, "_show", lambda p: shown.append(p["kind"]) or "shown")
    json.loads(system.handle({"action": "overview"}))
    assert shown == ["gauges"]
    json.loads(system.handle({"action": "overview", "show": False}))
    assert shown == ["gauges"]


def test_rings_from_points_and_json_wrapped_cards():
    rings = build_artifact({"kind": "rings", "title": "Usage", "points": [{"label": "CPU", "value": 13.2}, {"label": "Disk", "value": 86.6}]})
    assert [(r["value"], r["max"]) for r in rings["rings"]] == [(13.2, 100.0), (86.6, 100.0)]
    deck = build_artifact({"kind": "flashcards", "title": "x", "cards": '["What is SN2? :: One step", "What is E1? :: Two steps"]'})
    assert deck["flashcards"][0] == {"front": "What is SN2?", "back": "One step"}


def test_amounts_sent_as_rings_become_a_donut():
    spent = build_artifact({"kind": "rings", "title": "Spending", "unit": "$", "rows": [["Food", 200], ["Games", 500]], "columns": ["c", "a"]})
    assert spent["kind"] == "series" and spent["chart"]["style"] == "donut"
    assert spent["series"] == [{"label": "Food", "value": 200.0}, {"label": "Games", "value": 500.0}]
    usage = build_artifact({"kind": "rings", "title": "Usage", "items": [{"label": "CPU", "value": 13, "unit": "%"}]})
    assert usage["kind"] == "rings"
