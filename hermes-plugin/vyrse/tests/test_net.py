"""Web fetches fall back to IPv4 when the normal route hangs (2026-11-17: weather timed out on a half-up IPv6)."""
import io
import urllib.error

from vyrse import net


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_falls_back_to_ipv4_and_then_prefers_it(monkeypatch):
    calls = []

    def hang(request, timeout=None):
        calls.append(("normal", timeout))
        raise urllib.error.URLError("timed out")

    class V4:
        def open(self, request, timeout=None):
            calls.append(("v4", timeout))
            return _Resp(b"ok")

    monkeypatch.setattr(net, "_prefer_v4", False)
    monkeypatch.setattr(net.urllib.request, "urlopen", hang)
    monkeypatch.setattr(net, "_v4", V4())
    assert net.fetch("https://example.invalid/", 5.0) == b"ok"
    assert calls == [("normal", 2.5), ("v4", 5.0)]
    # the slow route is skipped from now on
    assert net.fetch("https://example.invalid/", 5.0) == b"ok"
    assert calls[2:] == [("v4", 5.0)]


def test_normal_route_is_used_when_it_works(monkeypatch):
    monkeypatch.setattr(net, "_prefer_v4", False)
    monkeypatch.setattr(net.urllib.request, "urlopen", lambda request, timeout=None: _Resp(b"fine"))
    assert net.fetch("https://example.invalid/") == b"fine"
    assert net._prefer_v4 is False


def test_an_alarm_the_user_asked_for_rings_even_without_the_flag():
    from vyrse.reminders import _label, wants_an_alarm

    assert wants_an_alarm({"action": "create", "schedule": "2:14 AM", "name": "alarm"}, "set an alarm for 2:14 AM")
    assert wants_an_alarm({"action": "create", "schedule": "7am"}, "wake me up at 7")
    assert wants_an_alarm({"action": "create", "schedule": "7am", "alarm": "true"}, "")
    assert wants_an_alarm({"action": "create", "schedule": "7am", "alarm": True}, "ring me at 7")
    # a reminder stays a reminder, whatever the model flags
    assert not wants_an_alarm({"action": "create", "schedule": "5pm", "alarm": True}, "remind me at 5pm to call mom")
    assert not wants_an_alarm({"action": "list"}, "what alarms do i have")
    assert _label("Remind me to call mom.") == "Call mom"
    assert _label("wake up") == "Wake up"
    assert len(_label("Tell the user that the chemistry test is tomorrow and they should revise chapter four tonight")) <= 41


def test_the_warm_up_chat_never_replaces_what_the_user_said(monkeypatch):
    from vyrse import turn

    turn.set_said("")
    turn.pre_llm_call(platform="vyrse", user_message="set an alarm for 2:21 AM", session_id="user-chat")
    turn.pre_llm_call(platform="vyrse", user_message=turn.WARMUP_PROMPT, session_id="warm-up")
    assert turn.said() == "set an alarm for 2:21 AM"
    # two real chats: a tool sees the words of its own conversation
    turn.pre_llm_call(platform="vyrse", user_message="whats the weather", session_id="other-chat")
    monkeypatch.setattr(turn, "_current_session", lambda: "user-chat")
    assert turn.said() == "set an alarm for 2:21 AM"
    monkeypatch.setattr(turn, "_current_session", lambda: "other-chat")
    assert turn.said() == "whats the weather"
    monkeypatch.setattr(turn, "_current_session", lambda: "unknown")
    assert turn.said() == "whats the weather"
