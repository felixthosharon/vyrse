"""Talk styles are switched by VYRSE itself (router.style_switch), not left to the model."""
import json

import pytest

from vyrse import router


@pytest.mark.parametrize("text,style", [
    ("switch to chill mode", "chill"), ("Switch to Vibe mode please", "vibe"), ("savage mode", "savage"),
    ("switch back to normal mode", "normal"), ("change it to pro", "pro"), ("turn on savage mode", "savage"),
    ("switch to focus mode", "focus"), ("hype mode!", "hype"),
])
def test_asking_for_a_style_is_recognised(text, style):
    assert router.style_switch(text) == style


@pytest.mark.parametrize("text", [
    "chill", "normal", "focus", "help me focus", "start focus mode for 25 minutes", "switch to gaming mode",
    "switch to private mode", "switch to dark mode", "what is savage mode?", "pro mode or focus mode, which is better?",
])
def test_other_requests_are_left_alone(text):
    assert router.style_switch(text) is None


def test_the_switch_is_made_and_answered_without_the_model(monkeypatch):
    from vyrse import tools

    asked = []
    monkeypatch.delenv("VYRSE_TEST_DRY", raising=False)
    monkeypatch.setattr(tools, "handle", lambda params, **_: asked.append(params) or json.dumps({"success": True, "applied": params["preferences"]}))
    out = router.pre_llm_call(platform="vyrse", user_message="switch to focus mode", session_id="s1")
    assert asked == [{"action": "set", "preferences": {"talkStyle": "focus"}}]
    assert "already switched" in out["context"]
    # the model must not start a study session for "focus mode", or switch again
    assert router.pre_tool_call("vyrse_focus", {"action": "start"}, session_id="s1")["action"] == "block"
    assert router.transform_llm_output("Locked in for 25 minutes!", session_id="s1", platform="vyrse").startswith("Focus style on.")


def test_a_failed_switch_goes_back_to_the_model(monkeypatch):
    from vyrse import tools

    monkeypatch.delenv("VYRSE_TEST_DRY", raising=False)
    monkeypatch.setattr(tools, "handle", lambda params, **_: json.dumps({"success": False, "error": "not connected"}))
    out = router.pre_llm_call(platform="vyrse", user_message="switch to pro mode", session_id="s2")
    assert "vyrse_ui" in out["context"]
    assert router.transform_llm_output("ok", session_id="s2", platform="vyrse") is None


def test_how_to_questions_do_not_trigger_the_action():
    assert router.hint_for("how do i take a screenshot on windows?") is None
    assert "vyrse_screen" in router.hint_for("take a screenshot")
