import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin

from vyrse import reminders  # noqa: E402


def test_parse_run_extracts_framed_response():
    doc = (
        "# Cron Job: Water\n\n**Job ID:** x\n\n## Prompt\n\nRemind\n\n---\n\n"
        "**Response Characters:** 21\n## Response\n\nTime to drink water!!\n"
    )
    assert reminders.parse_run(doc) == {"name": "Water", "text": "Time to drink water!!", "ok": True}


def test_parse_run_flags_blocked_runs():
    doc = "# Cron Job: X\n\n**Job ID:** x\n**Status:** BLOCKED\n\nThe agent was NOT run.\n"
    assert reminders.parse_run(doc)["ok"] is False


def test_create_forces_local_delivery_and_frames_prompt(monkeypatch):
    seen = {}
    import vyrse.tools as vtools

    # Stand-in for Hermes' tools.cronjob_tools (the plugin calls its handler unchanged).
    cron = types.ModuleType("tools.cronjob_tools")
    cron._cronjob_handler = lambda args, **kw: seen.update(args) or "{}"
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.cronjob_tools", cron)
    monkeypatch.setattr(vtools, "_in_vyrse_session", lambda: True)
    reminders.handle({"action": "create", "schedule": "in 1m", "prompt": "Remind the user to stretch.", "deliver": "telegram"})
    assert seen["deliver"] == "local"
    assert seen["prompt"].startswith(reminders._FRAME) and seen["prompt"].endswith("stretch.")


def test_briefing_phrases():
    from vyrse import briefing

    for yes in ["good morning", "Good morning!", "gm", "yo gm gng", "morning", "brief me", "what's my day like?", "daily briefing"]:
        assert briefing.wants_briefing(yes), yes
    for no in ["good morning, can you fix the bug in my login page and then email the team", "gmail", "morningstar fund price", "what's the weather"]:
        assert not briefing.wants_briefing(no), no
    assert briefing.pre_llm_call(platform="cli", user_message="gm") is None


def test_briefing_news_skips_shopping_and_repeats(monkeypatch):
    from vyrse import briefing

    ai = [{"title": "OpenAI announces 722 mathematical discoveries", "source": "A"},
          {"title": "OpenAI mathematical discoveries draw concerns", "source": "B"},
          {"title": "Anthropic ships a new model", "source": "C"},
          {"title": "Nvidia unveils AI laptop", "source": "D"}]
    tech = [{"title": "Amazon Prime Big Deal Days offers discounts on AirPods", "source": "E"},
            {"title": "Google rolls out SynthID detector globally", "source": "F"}]
    games = [{"title": "Valorant patch 11.08 nerfs Vandal spray", "source": "G"}]
    monkeypatch.setattr(briefing, "_games_query", lambda: "Valorant when:2d")
    monkeypatch.setattr(briefing, "_feed", lambda url: tech if "TECHNOLOGY" in url else games if "Valorant" in url else ai)
    titles = [h["title"] for h in briefing.headlines()]
    assert titles == ["OpenAI announces 722 mathematical discoveries", "Anthropic ships a new model",
                      "Google rolls out SynthID detector globally", "Valorant patch 11.08 nerfs Vandal spray"]
