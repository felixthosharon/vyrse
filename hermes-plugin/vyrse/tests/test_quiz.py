import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin

from vyrse import quiz  # noqa: E402


def test_quiz_flow_tracks_answers_and_ends_in_a_scorecard(tmp_path, monkeypatch):
    import hermes_constants
    from vyrse import tools

    shown = []
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: str(tmp_path))
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True)
    monkeypatch.setattr(quiz, "_session", lambda: "s1")
    monkeypatch.setattr(quiz, "_show", shown.append)

    res = json.loads(quiz.handle({"action": "start", "subject": "Physics", "questions": [
        {"question": "F = ?", "answer": "ma", "topic": "Newton"},
        {"question": "p = ?", "answer": "mv", "topic": "Momentum"},
        {"question": "Unit of force?", "answer": "newton", "topic": "Newton"}]}))
    assert res["success"] and "F = ?" in res["result"]
    # Nothing graded or revealed before an answer.
    assert shown[-1]["quiz"]["questions"][0] == {"question": "F = ?"}

    # Answers count only after the user has replied (the per-turn hook opens it), one per reply.
    assert not json.loads(quiz.handle({"action": "answer", "answer": "x", "correct": True}))["success"]
    reply = lambda said: quiz.pre_llm_call(platform="vyrse", session_id="s1", user_message=said)  # noqa: E731
    reply("ma")
    res = json.loads(quiz.handle({"action": "answer", "answer": "ma", "correct": True}))
    assert "p = ?" in res["result"]
    assert not json.loads(quiz.handle({"action": "answer", "answer": "made up", "correct": True}))["success"]
    reply("ma I think")
    res = json.loads(quiz.handle({"action": "answer", "answer": "ma", "correct": False}))
    assert shown[-1]["quiz"]["questions"][1] == {"question": "p = ?", "answer": "ma", "correct": False, "right_answer": "mv"}
    reply("newton")
    res = json.loads(quiz.handle({"action": "answer", "answer": "newton", "correct": True}))
    card = shown[-1]["scorecard"]
    assert (card["score"], card["total"]) == (2, 3)
    assert [t for t in card["topics"] if t["weak"]] == [{"label": "Momentum", "value": 0.0, "weak": True}]
    assert "Momentum" in res["result"] and quiz.load("s1") is None


def test_reminder_only_while_a_quiz_runs(tmp_path, monkeypatch):
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: str(tmp_path))
    assert quiz.pre_llm_call(platform="vyrse", session_id="s2") is None
    quiz.save("s2", {"questions": [{"question": "p = ?", "answer": "mv", "topic": ""}]})
    ctx = quiz.pre_llm_call(platform="vyrse", session_id="s2", user_message="mv")["context"]
    assert "p = ?" in ctx and "action=answer" in ctx
    assert quiz.pre_llm_call(platform="cli", session_id="s2") is None


def test_safety_net_records_a_missed_answer(tmp_path, monkeypatch):
    import hermes_constants
    from vyrse import workspace

    sent = []
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: str(tmp_path))
    monkeypatch.setattr(workspace, "deliver", lambda payload, **kw: sent.append(payload) or True)
    assert quiz.judge("That's not quite right. Momentum is mass times velocity.") is False
    assert quiz.judge("Correct! Well done.") is True
    assert quiz.judge("Sure, let me repeat the question.") is None
    assert quiz.judge("Close! The right answer is p = mv.") is None
    assert quiz.judge("You're absolutely right.") is True
    quiz.save("s3", {"questions": [{"question": "p = ?", "answer": "mv", "topic": "Momentum"},
                                   {"question": "F = ?", "answer": "ma", "topic": "Newton"}], "open": False})
    quiz.pre_llm_call(platform="vyrse", session_id="s3", user_message="mass times acceleration")  # the user replied
    quiz.post_llm_call(platform="vyrse", session_id="s3", user_message="mass times acceleration",
                       assistant_response="That's not quite right. It's p = mv. Next: F = ?")
    q = sent[-1]["artifact"]["quiz"]["questions"][0]
    assert q == {"question": "p = ?", "answer": "mass times acceleration", "correct": False, "right_answer": "mv"}
    # Recorded by the model this turn already (closed): the net stays out of it.
    quiz.post_llm_call(platform="vyrse", session_id="s3", user_message="ma", assistant_response="Correct!")
    assert len(sent) == 1


def test_chit_chat_mid_quiz_is_not_an_answer(tmp_path, monkeypatch):
    """The 2026-10-12 bug: 'Yo what's up' mid-quiz got recorded as a correct '56'."""
    import hermes_constants
    from vyrse import tools

    shown = []
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: str(tmp_path))
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True)
    monkeypatch.setattr(quiz, "_session", lambda: "s4")
    monkeypatch.setattr(quiz, "_show", shown.append)
    quiz.handle({"action": "start", "questions": [{"question": "7 x 8 = ?", "answer": "56"}, {"question": "9 x 6 = ?", "answer": "54"}]})
    hook = lambda said: quiz.pre_llm_call(platform="vyrse", session_id="s4", user_message=said)  # noqa: E731

    ctx = hook("I can't decide what to eat tonight, help me pick randomly.")["context"]
    assert "NOT an answer" in ctx and "mention the quiz" in ctx
    assert not json.loads(quiz.handle({"action": "answer", "answer": "56", "correct": True}))["success"]
    assert "NOT an answer" in hook("Yo what's up")["context"]
    assert quiz.load("s4")["dormant"]  # two off-topic messages: it goes quiet
    assert hook("lol") is None  # quiet: no more reminders
    assert "ask question 1 again" in hook("ok continue the quiz")["context"]
    hook("56")
    res = json.loads(quiz.handle({"action": "answer", "answer": "56", "correct": True}))
    assert res["success"] and "9 x 6" in res["result"]
    # A made-up answer that isn't in what the user typed is refused.
    hook("hmm fifty something")
    assert not json.loads(quiz.handle({"action": "answer", "answer": "54", "correct": True}))["success"]
    assert "stop" in hook("yoo get off the quiz")["context"]


def test_is_answer():
    for said in ("56", "Force equals mass times acceleration", "inertia", "speed is distance/time", "I think it's 54"):
        assert quiz.is_answer(said), said
    for said in ("Yo what's up", "Who made you?", "Help me practise times tables.", "quiz me on chemistry",
                 "What's the capital of Japan?", "stop the quiz", ""):
        assert not quiz.is_answer(said), said
    assert quiz.given_in("1/2 mv^2", "half m v squared, so 1/2 mv^2") and not quiz.given_in("56", "yo what's up")


def test_quiz_from_text(tmp_path, monkeypatch):
    """Qwen sent questions without the question field; one line per question is what it writes reliably."""
    import hermes_constants
    from vyrse import tools

    shown = []
    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: str(tmp_path))
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True)
    monkeypatch.setattr(quiz, "_session", lambda: "s5")
    monkeypatch.setattr(quiz, "_show", shown.append)
    res = json.loads(quiz.handle({"action": "start", "subject": "Organic", "text":
                                  "What is SN2? :: one-step substitution :: Mechanisms\nWhat is chirality? :: mirror images :: Stereo"}))
    assert res["success"] and "What is SN2?" in res["result"]
    assert quiz.load("s5")["questions"][1] == {"question": "What is chirality?", "answer": "mirror images", "topic": "Stereo"}
    bad = json.loads(quiz.handle({"action": "start", "questions": [{"answer": "x", "topic": "y"}]}))
    assert not bad["success"] and "::" in bad["error"]


def test_everyday_sentences_mid_quiz_are_not_answers():
    q, a = "What is the difference between SN1 and SN2 mechanisms?", "SN2 is concerted with backside attack"
    for said in ("I spent 200 on food, 150 on travel, 500 on games and 80 on snacks this month",
                 "My PC feels slow, what's going on?", "I slept 7 hours last night"):
        assert not (quiz.is_answer(said) and quiz.on_topic(said, q, a)), said
    for said in ("SN2 is a one step substitution with backside attack", "SN1 goes through a carbocation, SN2 is concerted",
                 "no idea", "56"):
        assert quiz.is_answer(said) and quiz.on_topic(said, q, a), said
    # A wrong answer that's still about the subject counts as an answer.
    assert quiz.on_topic("the nucleophile attacks from the front and it takes two steps in total", q, a + " nucleophile")
