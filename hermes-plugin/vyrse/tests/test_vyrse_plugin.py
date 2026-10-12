"""Unit tests for the vyrse Hermes plugin. Run with the Hermes venv:
    <hermes-agent>/venv/Scripts/python.exe -m pytest hermes-plugin/vyrse/tests -q
"""
import json
import sys
from pathlib import Path

import pytest

PLUGIN_PARENT = Path(__file__).resolve().parents[2]  # .../hermes-plugin
sys.path.insert(0, str(PLUGIN_PARENT))

from vyrse import tools, ui_state  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setattr(ui_state, "state_path", lambda: tmp_path / "vyrse" / "ui_state.json")
    return tmp_path


@pytest.fixture
def vyrse_session(monkeypatch):
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True)
    sent = []
    monkeypatch.setattr(tools, "_emit", lambda payload: sent.append(payload) or True)
    return sent


def test_validate_accepts_known_values_and_rejects_others():
    ok, errors = ui_state.validate({"theme": "light", "textSize": 1.1, "voiceResponses": False, "theme2": 1, "density": "huge"})
    assert ok == {"theme": "light", "textSize": 1.1, "voiceResponses": False}
    assert set(errors) == {"theme2", "density"}


def test_update_persists_and_merges():
    ui_state.update({"theme": "light"})
    prefs, errors = ui_state.update({"density": "compact"})
    assert prefs == {"theme": "light", "density": "compact"}
    assert errors == {}
    assert ui_state.load() == prefs


def test_tool_refuses_outside_vyrse_sessions(monkeypatch):
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: False)
    result = json.loads(tools.handle({"action": "get_state"}))
    assert result["success"] is False


def test_set_saves_and_emits_only_valid_prefs(vyrse_session):
    result = json.loads(tools.handle({"action": "set", "preferences": {"theme": "light", "bogus": 1}}))
    assert result["success"] is True
    assert result["applied"] == {"theme": "light"}
    assert "bogus" in result["rejected"]
    assert vyrse_session == [{"action": "prefs", "prefs": {"theme": "light"}}]
    assert ui_state.load()["theme"] == "light"


def test_open_and_mode_are_validated(vyrse_session):
    assert json.loads(tools.handle({"action": "open", "panel": "garage"}))["success"] is False
    assert json.loads(tools.handle({"action": "open", "panel": "settings"}))["success"] is True
    assert json.loads(tools.handle({"action": "set_mode", "mode": "gaming"}))["success"] is True
    assert ui_state.load()["mode"] == "gaming"
    assert [p["action"] for p in vyrse_session] == ["open", "mode"]


def test_reports_disconnected_window(monkeypatch):
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True)
    monkeypatch.setattr(tools, "_emit", lambda payload: False)
    result = json.loads(tools.handle({"action": "notify", "text": "hi"}))
    assert result["success"] is False and "not connected" in result["error"]


def test_prompt_section_fits_hermes_limit():
    # Hermes drops a plugin prompt section over 4000 characters entirely; leave headroom.
    import vyrse

    assert len(vyrse.PROMPT) < 3600
    assert "Doing beats saying" in vyrse.PROMPT


def test_every_talk_style_keeps_the_action_rule():
    from vyrse import talk_styles, ui_state

    assert "savage" in talk_styles.STYLES and "savage" in ui_state.CHOICES["talkStyle"]
    for style in talk_styles.STYLES:
        ctx = talk_styles.context_for(style)
        assert "call the tool first" in ctx, style
    savage = talk_styles.context_for("savage")
    assert "no slurs" in savage and "2 to 3 sentences" in savage and "never a replacement" in savage
    assert "short paragraph" not in savage  # not the long chatty rule: a roast hits and stops


def test_styles_use_the_users_name_not_a_fixed_one(monkeypatch):
    from vyrse import talk_styles, ui_state

    monkeypatch.setattr(ui_state, "load", lambda: {"userName": "Sam"})
    for style in talk_styles.STYLES:
        ctx = talk_styles.context_for(style)
        assert "{name}" not in ctx, style
    assert "Sam" in talk_styles.context_for("vibe")
    monkeypatch.setattr(ui_state, "load", lambda: {})
    assert "the user" in talk_styles.context_for("normal")


def test_user_name_is_validated():
    from vyrse import ui_state

    ok, errors = ui_state.validate({"userName": "  Sam   Lee "})
    assert ok == {"userName": "Sam Lee"} and not errors
    for bad in ["", "x" * 41, "<script>", "{name}", 5]:
        assert "userName" in ui_state.validate({"userName": bad})[1], bad
