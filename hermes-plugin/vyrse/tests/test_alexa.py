import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin


def _setup(monkeypatch, tmp_path, answer=None):
    from vyrse import alexa, confirm, desktop_call, tools

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True, raising=False)
    calls = []
    monkeypatch.setattr(desktop_call, "call", lambda target, op, args=None, timeout=30: calls.append((op, args)) or {"ok": True})
    asked = []
    monkeypatch.setattr(confirm, "ask", lambda q, choices, timeout=180: asked.append(q) or answer)
    posts = []
    monkeypatch.setattr(alexa, "_voicemonkey", lambda endpoint, body: posts.append((endpoint, body)) or {"ok": True})
    return alexa, calls, asked, posts


def test_command_strips_wake_word_and_runs(monkeypatch, tmp_path):
    alexa, calls, asked, _ = _setup(monkeypatch, tmp_path)
    out = json.loads(alexa.handle({"action": "command", "text": "Alexa, turn off the lights"}))
    assert out["ok"] and calls == [("command", {"text": "turn off the lights"})] and not asked


def test_purchases_need_approval(monkeypatch, tmp_path):
    alexa, calls, asked, _ = _setup(monkeypatch, tmp_path, answer="Cancel")
    out = json.loads(alexa.handle({"action": "command", "text": "order more paper towels"}))
    assert not out["ok"] and asked and calls == []
    alexa, calls, asked, _ = _setup(monkeypatch, tmp_path, answer="Do it")
    assert json.loads(alexa.handle({"action": "command", "text": "buy AA batteries"}))["ok"] and calls


def test_voicemonkey_token_never_reaches_the_ui(monkeypatch, tmp_path):
    alexa, calls, _, posts = _setup(monkeypatch, tmp_path)
    view = alexa.save_voicemonkey("secret-token", "echo-dot", {"Bedtime": "trigger-1"})
    assert view == {"configured": True, "speaker": "echo-dot", "routines": {"Bedtime": "trigger-1"}}
    assert "secret-token" not in json.dumps(alexa.public_voicemonkey())
    # say goes through Voice Monkey once it's set up; routines by name too
    alexa.handle({"action": "say", "text": "dinner is ready"})
    alexa.handle({"action": "routine", "name": "bedtime"})
    assert posts == [("announce", {"device": "echo-dot", "speech": "dinner is ready"}), ("trigger", {"device": "trigger-1"})]
    assert calls == []
    assert alexa.save_voicemonkey("", None, None)["configured"] is False


def test_say_without_voicemonkey_uses_the_signin(monkeypatch, tmp_path):
    alexa, calls, _, posts = _setup(monkeypatch, tmp_path)
    alexa.handle({"action": "say", "text": "hi"})
    assert calls == [("speak", {"text": "hi"})] and posts == []
