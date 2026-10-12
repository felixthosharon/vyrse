import sys
import threading
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin


def _kokoro_module():
    # kokoro_tts imports Hermes' TTS base class; a stand-in is enough for the text helpers.
    agent = types.ModuleType("agent")
    tts = types.ModuleType("agent.tts_provider")
    tts.TTSProvider = type("TTSProvider", (), {})
    streaming = types.ModuleType("tools.tts_streaming")
    streaming.StreamingTTSProvider = type("StreamingTTSProvider", (), {})
    sys.modules.setdefault("agent", agent)
    sys.modules.setdefault("agent.tts_provider", tts)
    sys.modules.setdefault("tools", types.ModuleType("tools"))
    sys.modules.setdefault("tools.tts_streaming", streaming)
    from vyrse import kokoro_tts
    return kokoro_tts


def test_name_is_respelled_for_kokoro():
    k = _kokoro_module()
    assert k.apply_pronunciations("Hi, I'm VYRSE. Vyrse's here.") == "Hi, I'm Vyse. Vyse's here."
    assert k.apply_pronunciations("vyrse-hermes stays") == "vyrse-hermes stays"
    assert k.apply_pronunciations("VYRSE", {"VYRSE": "Wise"}) == "Wise"


def test_confirm_waits_for_the_answer(monkeypatch):
    from vyrse import confirm

    sent = {}
    ui = types.ModuleType("tools.desktop_ui")
    ui.emit = lambda name, payload: sent.update(payload) or True
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.desktop_ui", ui)
    monkeypatch.setattr(sys.modules["tools"], "desktop_ui", ui, raising=False)

    def answer_later():
        while "id" not in sent:
            pass
        confirm.answer(sent["id"], "Install")

    threading.Thread(target=answer_later, daemon=True).start()
    assert confirm.ask("Add it?", ["Install", "Not now"], timeout=5) == "Install"
    assert confirm.answer("unknown", "Install") is False


def test_slang_is_spoken_like_people_say_it():
    k = _kokoro_module()
    assert k.apply_pronunciations("Yooo wsup bro, ngl that was fire fr.") == "Yo wassup bro, not gonna lie that was fire for real."
    assert k.apply_pronunciations("idk tbh, btw u good?") == "I dunno to be honest, by the way you good?"


def test_slang_leaves_paths_flags_and_abbreviations_alone():
    k = _kokoro_module()
    assert k.apply_pronunciations("Run cmd /u now") == "Run cmd /u now"
    assert k.apply_pronunciations("The U.S. and UR team") == "The U.S. and UR team"
    assert k.apply_pronunciations(r"Open C:\fr\ig now") == r"Open C:\fr\ig now"
