"""Interactive workspace: multiple-choice quizzes marked by the plugin, buttons, forms, timer and board updates."""
import json

import pytest


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    shown = []
    from vyrse import workspace

    monkeypatch.setattr(workspace, "deliver", lambda payload, **_: shown.append(payload))
    return shown


def _quiz(session="s1"):
    from vyrse import quiz

    q = {"subject": "Chem", "title": "Chem quiz", "open": False, "questions": [
        {"question": "What is H2O?", "answer": "Water", "topic": "Basics", "choices": ["Salt", "Water", "Sugar"]},
        {"question": "Symbol for gold?", "answer": "Au", "topic": "Elements", "choices": ["Ag", "Au", "Gd"]},
    ]}
    quiz.save(session, q)
    return quiz


def test_tapped_answer_is_marked_by_the_plugin(home):
    quiz = _quiz()
    out = quiz.pre_llm_call(platform="vyrse", session_id="s1", user_message="My answer: Water")
    assert "RIGHT" in out["context"] and "question 2" in out["context"]
    saved = quiz.load("s1")
    assert saved["questions"][0]["given"] == "Water" and saved["questions"][0]["correct"] is True
    card = home[-1]["artifact"]
    assert card["quiz"]["current"] == 1 and card["quiz"]["questions"][0]["choices"]


def test_letter_answer_and_finish(home):
    quiz = _quiz()
    quiz.pre_llm_call(platform="vyrse", session_id="s1", user_message="a")  # Salt: wrong
    out = quiz.pre_llm_call(platform="vyrse", session_id="s1", user_message="My answer: Au")
    assert "scorecard" in out["context"] and quiz.load("s1") is None
    score = home[-1]["artifact"]["scorecard"]
    assert score["score"] == 1 and score["total"] == 2


def test_a_question_mentioning_an_option_is_not_an_answer(home):
    quiz = _quiz()
    quiz.pre_llm_call(platform="vyrse", session_id="s1", user_message="wait what is water actually used for in the body though")
    assert "given" not in quiz.load("s1")["questions"][0]


def test_choices_from_text_include_the_answer():
    from vyrse import quiz
    from vyrse.workspace import pairs_from_text

    f = pairs_from_text("Capital of France? :: Paris :: Geo :: Lyon | Nice | Marseille", parts=10)[0]
    assert quiz._choices(f[3:], f[1]) == ["Lyon", "Paris", "Nice", "Marseille"][:4] or "Paris" in quiz._choices(f[3:], f[1])


def test_buttons_and_form_build():
    from vyrse import workspace

    art = workspace.build_artifact({"action": "show", "kind": "form", "id": "trip", "title": "Trip",
                                    "fields": "Where :: text :: Goa\nBudget :: select :: Low/Mid/High",
                                    "submit": "Plan it", "buttons": "Cheaper :: Make it cheaper\nNope"})
    assert art["form"]["fields"][1]["options"] == ["Low", "Mid", "High"]
    assert art["actions"][0] == {"label": "Cheaper", "prompt": "Make it cheaper"}
    assert art["actions"][1] == {"label": "Nope", "prompt": "Nope"}


def test_store_updates(home):
    from vyrse import workspace

    workspace.store_show("s2", {"id": "t", "title": "Focus", "kind": "timer", "timer": {"label": "Focus", "ends_at": 10**13, "seconds": 1500}})
    paused = workspace.store_update("s2", "t", "timer", {"action": "pause"})
    assert "paused_left" in paused["timer"]
    resumed = workspace.store_update("s2", "t", "timer", {"action": "resume"})
    assert "paused_left" not in resumed["timer"]
    workspace.store_show("s2", {"id": "b", "title": "Tasks", "kind": "board", "board": [
        {"name": "To do", "cards": [{"label": "Essay"}]}, {"name": "Done", "cards": []}]})
    moved = workspace.store_update("s2", "b", "board_move", {"from": 0, "to": 1, "label": "Essay"})
    assert moved["board"][1]["cards"] == [{"label": "Essay"}] and not moved["board"][0]["cards"]
    assert workspace.store_update("s2", "b", "board_move", {"from": 0, "to": 1, "label": "Nope"}) is None
    assert workspace.load_items("s2")[0]["board"][1]["cards"][0]["label"] == "Essay" or any(
        a.get("id") == "b" and a["board"][1]["cards"] for a in workspace.load_items("s2"))
