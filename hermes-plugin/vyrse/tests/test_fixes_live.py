"""Fixes from a real session: lenient boards, misspelt quiz answers, no silent replies, safe typing."""
import json


def test_board_from_children():
    from vyrse import workspace

    a = workspace.build_artifact({"action": "show", "kind": "board", "title": "Trip", "items": [
        {"group": "To Do", "children": ["Pick hotels", "Reserve dinner"]}, {"label": "Book flights", "group": "Done"}]})
    assert [c["name"] for c in a["board"]] == ["To Do", "Done"]
    assert [x["label"] for x in a["board"][0]["cards"]] == ["Pick hotels", "Reserve dinner"]


def test_misspelt_answers_count_but_lookalikes_dont():
    from vyrse.quiz import close_enough

    assert close_enough("mitchondrion", "Mitochondria") and close_enough("ribosome", "Ribosomes")
    assert not close_enough("meiosis", "mitosis") and not close_enough("1945", "1944") and not close_enough("cat", "car")


def test_silent_turn_gets_a_line():
    from vyrse import fallback

    fallback.post_tool_call("vyrse_quiz", json.dumps({"success": True, "result":
        'Recorded question 1 as right. Write your reply now, then ask question 2: "Which planet is red?"'}), "s9")
    out = fallback.transform_llm_output("the turn stopped while a tool result was still pending. Send `continue`.", "s9", "vyrse")
    assert out == 'Right! Question 2: Which planet is red?'
    fallback.post_tool_call("vyrse_workspace", json.dumps({"success": True, "result": "showing 'Plan' in the workspace"}), "s9")
    assert fallback.transform_llm_output("Here's your plan.", "s9", "vyrse") is None  # a real reply is left alone


def test_named_files_are_protected():
    from vyrse.desktop import _named_file

    assert _named_file("*youtube.txt - Notepad") and not _named_file("Untitled - Notepad") and not _named_file("Calculator")
