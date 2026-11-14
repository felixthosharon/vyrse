"""Settings -> Memory: listing and editing Hermes' built-in notes through its own MemoryStore."""
import importlib.util
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parents[1]


@pytest.fixture()
def api(tmp_path, monkeypatch):
    from tools import memory_tool

    monkeypatch.setattr(memory_tool, "get_memory_dir", lambda: tmp_path)
    spec = importlib.util.spec_from_file_location("vyrse_memory_api_test", PLUGIN / "dashboard" / "memory_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_add_list_edit_remove(api):
    assert api.listing()["user"]["entries"] == []
    added = api.add("user", "Prefers short answers.")
    assert added["ok"] and added["memory"]["user"]["entries"] == ["Prefers short answers."]
    api.add("memory", "The printer is on the second floor.")
    listing = api.listing()
    assert listing["memory"]["entries"] == ["The printer is on the second floor."]
    assert 0 < listing["user"]["used"] <= listing["user"]["limit"]

    edited = api.replace("user", "Prefers short answers.", "Prefers short answers with examples.")
    assert edited["ok"] and edited["memory"]["user"]["entries"] == ["Prefers short answers with examples."]

    removed = api.remove("user", "Prefers short answers with examples.")
    assert removed["ok"] and removed["memory"]["user"]["entries"] == []
    assert api.listing()["memory"]["entries"] == ["The printer is on the second floor."]


def test_refuses_bad_notes(api):
    assert not api.add("user", "   ")["ok"]
    assert not api.add("nowhere", "x")["ok"]
    assert not api.add("user", "a" * 700)["ok"]
    assert not api.add("user", "one \u00a7 two")["ok"]
    assert api.listing()["user"]["entries"] == []


def test_editing_a_note_that_changed_is_refused_and_removing_a_gone_note_is_fine(api):
    api.add("user", "Likes tea.")
    assert not api.replace("user", "Likes coffee.", "Likes water.")["ok"]
    assert api.remove("user", "Likes coffee.")["ok"]
    assert api.listing()["user"]["entries"] == ["Likes tea."]


def test_full_memory_gives_a_plain_message(api):
    limit = api.listing()["user"]["limit"]
    note = "x" * 500
    for i in range(limit // 500 + 2):
        last = api.add("user", f"{i} {note}")
    assert not last["ok"] and "full" in last["message"].lower()
