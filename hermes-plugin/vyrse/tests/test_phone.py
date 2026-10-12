import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin


def _setup(monkeypatch, result=None):
    from vyrse import desktop_call, phone, tools

    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True, raising=False)
    calls = []
    monkeypatch.setattr(
        desktop_call, "call",
        lambda target, op, args=None, timeout=30: calls.append((target, op, args)) or (result or {"ok": True}),
    )
    return phone, calls


def test_routes_to_the_phone_with_only_known_args(monkeypatch):
    phone, calls = _setup(monkeypatch)
    out = json.loads(phone.handle({"action": "flashlight", "state": "on", "junk": "x", "level": None}))
    assert out["ok"] and calls == [("phone", "flashlight", {"state": "on"})]


def test_unknown_action_is_refused(monkeypatch):
    phone, calls = _setup(monkeypatch)
    out = json.loads(phone.handle({"action": "install_app"}))
    assert not out["ok"] and calls == []


def test_empty_notifications_get_a_note(monkeypatch):
    phone, _ = _setup(monkeypatch, {"ok": True, "count": 0, "notifications": []})
    out = json.loads(phone.handle({"action": "notifications"}))
    assert out["note"]


def test_sensitive_tap_asks_the_user_then_retries_confirmed(monkeypatch):
    from vyrse import confirm, desktop_call, phone, tools

    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True, raising=False)
    calls = []

    def fake(target, op, args=None, timeout=30):
        calls.append(dict(args or {}))
        return {"ok": True, "tapped": "Send"} if (args or {}).get("confirmed") == "yes" else {
            "ok": False, "needs_confirmation": True, "label": "Send"}

    monkeypatch.setattr(desktop_call, "call", fake)
    asked = []
    monkeypatch.setattr(confirm, "ask", lambda q, choices, timeout=180: asked.append(q) or "Tap it")
    out = json.loads(phone.handle({"action": "tap", "text": "Send"}))
    assert out["ok"] and asked and "Send" in asked[0]
    assert calls == [{"text": "Send"}, {"text": "Send", "confirmed": "yes"}]


def test_declined_sensitive_tap_is_not_retried(monkeypatch):
    from vyrse import confirm, desktop_call, phone, tools

    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True, raising=False)
    calls = []
    monkeypatch.setattr(desktop_call, "call", lambda t, op, args=None, timeout=30: calls.append(args) or {
        "ok": False, "needs_confirmation": True, "label": "Pay"})
    monkeypatch.setattr(confirm, "ask", lambda q, choices, timeout=180: "Cancel")
    out = json.loads(phone.handle({"action": "tap", "n": 4}))
    assert not out["ok"] and len(calls) == 1


def test_screenshot_becomes_a_file_for_vision(monkeypatch, tmp_path):
    import base64
    import types

    from vyrse import desktop_call, phone, tools

    monkeypatch.setitem(sys.modules, "hermes_constants", types.SimpleNamespace(get_hermes_home=lambda: str(tmp_path)))
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True, raising=False)
    jpeg = base64.b64encode(b"\xff\xd8fakejpeg").decode()
    monkeypatch.setattr(desktop_call, "call", lambda t, op, args=None, timeout=30: {"ok": True, "jpeg_base64": jpeg})
    out = json.loads(phone.handle({"action": "screenshot"}))
    assert "jpeg_base64" not in out and Path(out["image"]).read_bytes().startswith(b"\xff\xd8")
