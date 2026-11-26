"""Spec questions are answered from the machine (2026-11-27: a small model invented a friend's hardware)."""
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin

from vyrse import router, system  # noqa: E402


def test_specs_reads_the_machine():
    s = system.specs()
    assert s["cpu"] and s["cpu"] != "unknown"
    assert s["cpu_threads"] >= s["cpu_cores"] >= 1
    assert s["ram_gb"] >= 1
    assert s["windows"].startswith("Windows")
    line = system.specs_line()
    assert s["cpu"] in line and f"RAM {s['ram_gb']} GB" in line


def test_specs_action_shows_a_card(monkeypatch):
    shown = []
    monkeypatch.setattr(system, "_show", lambda params: shown.append(params) or "shown")
    out = json.loads(system.handle({"action": "specs"}))
    assert out["success"] and out["specs"]["cpu"]
    assert shown and shown[0]["id"] == "pc-specs"


def _context(text):
    return router.pre_llm_call(platform="vyrse", user_message=text, session_id="t")["context"]


def test_spec_questions_carry_the_real_hardware():
    for text in ("what are my system specs?", "what's my gpu", "how much ram do i have", "what graphics card do i have"):
        assert "real hardware" in _context(text) and system.specs()["cpu"] in _context(text)
    for text in ("what are the specs of the iphone 17", "hi", "how do I check my specs?"):
        assert "real hardware" not in _context(text)


def test_pc_status_goes_to_the_live_gauges():
    for text in ("How's my PC doing? Show it as a dashboard in the workspace: gauges for CPU, RAM and GPU.",
                 "show my system stats"):
        assert "vyrse_system action=overview" in _context(text)
