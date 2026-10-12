import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin


@pytest.fixture
def training(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "hermes_constants", types.SimpleNamespace(get_hermes_home=lambda: str(tmp_path)))
    from vyrse.wake import training as t

    t._state.clear()
    t._state.update({"phase": "idle", "message": ""})
    return t


def pcm(seconds: float) -> bytes:
    return b"\x01\x00" * int(16000 * seconds)


def test_takes_are_stored_and_counted(training, tmp_path):
    assert training.save_sample("wake", pcm(1.0)) == {"wake": 1, "other": 0}
    assert training.save_sample("other", pcm(5.0)) == {"wake": 1, "other": 1}
    assert len(list((tmp_path / "vyrse" / "wake-train" / "positive").glob("*.wav"))) == 1


@pytest.mark.parametrize("kind,seconds", [("wake", 0.1), ("wake", 4.0), ("other", 0.5), ("other", 12.0), ("bogus", 1.0)])
def test_bad_recordings_are_refused(training, kind, seconds):
    with pytest.raises(ValueError):
        training.save_sample(kind, pcm(seconds))


def test_odd_byte_count_is_refused(training):
    with pytest.raises(ValueError):
        training.save_sample("wake", pcm(1.0) + b"\x00")


def test_take_limit_and_clear(training):
    for _ in range(training.MAX_TAKES):
        training.save_sample("wake", pcm(1.0))
    with pytest.raises(ValueError):
        training.save_sample("wake", pcm(1.0))
    assert training.clear() == {"wake": 0, "other": 0}


def test_training_needs_enough_takes(training):
    for _ in range(4):
        training.save_sample("wake", pcm(1.0))
    with pytest.raises(ValueError):
        training.start()
