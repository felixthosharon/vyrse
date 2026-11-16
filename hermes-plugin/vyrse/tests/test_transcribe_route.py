"""VYRSE's transcription route keeps short answers Hermes' route drops, and still drops silence noise."""
import importlib.util
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parents[1]


@pytest.fixture()
def api():
    spec = importlib.util.spec_from_file_location("vyrse_plugin_api_test", PLUGIN / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_short_answers_are_kept(api):
    for said in ("Okay.", "OK", "Thanks.", "Thank you!", "Bye.", "Okay, thanks."):
        assert api.keep_transcript(said) == said, said


def test_silence_noise_is_still_dropped(api):
    for noise in ("you", "Thanks for watching!", "Thank you. Thank you. Thank you.", "Please subscribe.", "", "  "):
        assert api.keep_transcript(noise) == "", noise
    assert api.keep_transcript(" open spotify ") == "open spotify"


def test_route_uses_hermes_transcription(api, monkeypatch):
    from tools import transcription_tools

    seen = {}

    def fake(path, model=None, source=None):
        seen["exists"] = Path(path).is_file()
        seen["source"] = source
        return {"success": True, "transcript": "Okay.", "provider": "local"}

    monkeypatch.setattr(transcription_tools, "transcribe_audio", fake)
    out = api._transcribe_bytes(b"RIFF....WAVE", "audio/wav")
    assert out == {"ok": True, "transcript": "Okay.", "provider": "local"} and seen == {"exists": True, "source": "voice_mode"}
    monkeypatch.setattr(transcription_tools, "transcribe_audio", lambda *a, **k: {"success": False, "error": "empty transcript"})
    assert api._transcribe_bytes(b"x", "audio/wav")["transcript"] == ""
