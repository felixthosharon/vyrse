"""VYRSE desktop integration plugin for Hermes Agent.

- `vyrse_ui` tool (toolset `vyrse_ui`): Hermes controls the VYRSE interface.
- A short system-prompt section, only in VYRSE sessions (source "vyrse").
- dashboard/plugin_api.py: REST routes for VYRSE interface preferences.
"""
from __future__ import annotations

from typing import Any, Mapping

from . import tools

# Hermes skips a plugin prompt section over 4000 characters entirely (it did, silently, from 2026-10-06 to
# 10-09): keep this under ~3600 (tests/test_vyrse_plugin.py checks). Tool details live in each tool's description.
PROMPT = (
    "You run inside VYRSE on the user's own Windows PC, with permission to operate it.\n"
    "- Felix made you (he designed and built VYRSE): asked who made you, say Felix. Hermes Agent and the model "
    "are just the open-source engine, never your maker.\n"
    "- Doing beats saying: when asked to do something, call the tool and wait for its result before you say "
    "it's done, in every talk style. Never claim an action you didn't take; if a tool fails, say so.\n"
    "- Windows, not Linux: `terminal` is Git Bash on Windows; for Windows commands use "
    "`powershell.exe -NoProfile -Command '...'` (single quotes, or Git Bash eats `$_`). Never ps/df/top/du. `python3` may be missing. Data files "
    "(CSV, Excel, JSON): `vyrse_analyse` does the maths and the dashboard; never make numbers up.\n"
    "- Work in the background so the user can keep using the PC; take the most direct route: files and "
    "settings via file tools/PowerShell; apps via `vyrse_desktop` (opens, types, reads, presses buttons "
    "without the mouse); `computer_use` only if vyrse_desktop can't (load it with tool_search; pass `app`).\n"
    "- Use the VYRSE tools for their jobs: `vyrse_system` (CPU, RAM, GPU, disks, apps, what's eating storage; "
    "show=true for a chart), `vyrse_controls` (music, volume, brightness, lock, clipboard), `vyrse_files` (find files "
    "instantly; never walk folders), `vyrse_reminders` (reminders and routines), `vyrse_briefing` (\"good "
    "morning\", \"brief me\"; a city only if known), `vyrse_screen` (what's on screen; `vision_analyze` "
    "for the image), `vyrse_alexa` (the Echo: commands, speech, routines), `vyrse_phone` (the user's phone: "
    "find it, flashlight, battery, media, notifications; and full control: screen, tap, type, swipe, open apps; "
    "read the screen before acting; summarise notifications briefly), `vyrse_ui` "
    "(VYRSE itself: theme, panels, conversations, mode, model, voice on/off).\n"
    "- Current facts, news, prices, weather: `web_search` (+ `web_extract`). Browser tools only to interact "
    "with a site; if it needs an account, ask the user to sign in once in that window. Private mode blocks "
    "online tools.\n"
    "- Before a multi-step task, load a matching installed skill (skill_view); `vyrse_skills` can find and "
    "install more from the Skills Hub after the user confirms.\n"
    "- The workspace (`vyrse_workspace`) is your canvas beside the chat. When you analyse, compare, track, "
    "plan, monitor, report or teach, show it there in the picture that fits: charts, rings, gauges, stats, "
    "cards, mind maps, checklists, boards, timers, wheels, flashcards, or a small HTML app you write (tables "
    "only for text side by side); several items make a dashboard. Skip it for small "
    "talk and one-line answers. No ASCII charts. Logging ('log …', 'track …'): `vyrse_log`.\n"
    "- With something on screen, reply with just the headline in a sentence or two: the finding, total or "
    "verdict, the key fact in bold unless the talk style says no bold (\"Here you go. **Saturday** ran the "
    "hottest, at **78°C**.\"). Never re-list what the card shows.\n"
    "- Quizzes ('quiz me'): `vyrse_quiz` (start; action=answer only when a reply answers the question).\n"
    "- Dropped files arrive as @file: references; read them with the file tools.\n"
    "- Your voice: VYRSE reads replies aloud (local Kokoro voice). The user talks to you by saying your name "
    "(VYRSE, said \"vyse\") or the mic button. Never say you can't speak. Write replies that sound natural "
    "aloud. In most talk styles only the first two or three sentences are spoken, so open a long answer with "
    "the gist itself (not \"Here's the breakdown:\"); the rest is on screen. The talk style can change this.\n"
    "- Keep spoken confirmations short."
)


BRIEFING_SCHEMA = {
    "name": "vyrse_briefing",
    "description": (
        "Daily briefing in one call: local time, weather, today's reminders, a few headlines, and PC issues "
        "that need attention. Use for 'good morning', 'brief me', 'what's my day like'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "Only a CITY the user named or saved in memory (never a country or timezone); omit to locate automatically."},
            "news_topic": {"type": "string", "description": "Optional news focus, e.g. 'tech' or 'football'."},
        },
    },
}


def _prompt_section(info: Mapping[str, Any]) -> str:
    return PROMPT if info.get("platform") == "vyrse" else ""


def register(ctx) -> None:
    ctx.register_tool(
        name="vyrse_ui",
        toolset="vyrse_ui",
        schema=tools.SCHEMA,
        handler=tools.handle,
        description=tools.SCHEMA["description"],
    )
    ctx.register_system_prompt_section("vyrse.ui", _prompt_section)

    # Talk styles: the chosen style rides along with every message (switchable mid-conversation).
    from . import talk_styles

    ctx.register_hook("pre_llm_call", talk_styles.pre_llm_call)

    from . import controls, desktop, quiz, screen, skills_hub, system, workspace
    from . import analyse
    from . import log as logs

    ctx.register_tool(
        name="vyrse_analyse",
        toolset="vyrse_ui",
        schema=analyse.SCHEMA,
        handler=analyse.handle,
        description=analyse.SCHEMA["description"],
    )

    ctx.register_tool(
        name="vyrse_log",
        toolset="vyrse_ui",
        schema=logs.SCHEMA,
        handler=logs.handle,
        description=logs.SCHEMA["description"],
    )
    ctx.register_tool(
        name="vyrse_quiz",
        toolset="vyrse_ui",
        schema=quiz.SCHEMA,
        handler=quiz.handle,
        description=quiz.SCHEMA["description"],
    )
    ctx.register_hook("pre_llm_call", quiz.pre_llm_call)
    ctx.register_hook("post_llm_call", quiz.post_llm_call)

    ctx.register_tool(
        name="vyrse_controls",
        toolset="vyrse_ui",
        schema=controls.SCHEMA,
        handler=controls.handle,
        description=controls.SCHEMA["description"],
    )

    ctx.register_tool(
        name="vyrse_system",
        toolset="vyrse_ui",
        schema=system.SCHEMA,
        handler=system.handle,
        description=system.SCHEMA["description"],
    )

    ctx.register_hook("pre_llm_call", workspace.pre_llm_call)
    ctx.register_tool(
        name="vyrse_workspace",
        toolset="vyrse_ui",
        schema=workspace.SCHEMA,
        handler=workspace.handle,
        description=workspace.SCHEMA["description"],
    )

    ctx.register_tool(
        name="vyrse_skills",
        toolset="vyrse_ui",
        schema=skills_hub.SCHEMA,
        handler=skills_hub.handle,
        description=skills_hub.SCHEMA["description"],
    )

    ctx.register_tool(
        name="vyrse_desktop",
        toolset="vyrse_ui",
        schema=desktop.SCHEMA,
        handler=desktop.handle,
        description=desktop.SCHEMA["description"],
    )

    ctx.register_tool(
        name="vyrse_screen",
        toolset="vyrse_ui",
        schema=screen.SCHEMA,
        handler=screen.handle,
        description=screen.SCHEMA["description"],
    )

    # Reminders and routines: run Hermes' cron scheduler while VYRSE is open.
    from . import reminders

    reminders.start()

    # Remove VYRSE's own leftovers (old hidden warm-ups, empty "Ready" rows) from history.
    from . import housekeeping

    housekeeping.start()
    from . import usage

    usage.start()
    from . import briefing

    ctx.register_hook("pre_llm_call", briefing.pre_llm_call)
    from . import alexa

    ctx.register_tool(
        name="vyrse_alexa",
        toolset="vyrse_ui",
        schema=alexa.SCHEMA,
        handler=alexa.handle,
        description=alexa.SCHEMA["description"],
    )
    from . import phone

    ctx.register_tool(
        name="vyrse_phone",
        toolset="vyrse_ui",
        schema=phone.SCHEMA,
        handler=phone.handle,
        description=phone.SCHEMA["description"],
    )
    from . import files

    ctx.register_tool(
        name="vyrse_files",
        toolset="vyrse_ui",
        schema=files.SCHEMA,
        handler=files.handle,
        description=files.SCHEMA["description"],
    )
    ctx.register_tool(
        name="vyrse_briefing",
        toolset="vyrse_ui",
        schema=BRIEFING_SCHEMA,
        handler=briefing.handle,
        description=BRIEFING_SCHEMA["description"],
    )
    ctx.register_tool(
        name="vyrse_reminders",
        toolset="vyrse_ui",
        schema=reminders.SCHEMA,
        handler=reminders.handle,
        description=reminders.SCHEMA["description"],
    )

    # Local Kokoro voice (tts.provider: kokoro). Hermes' streaming registry is module-level,
    # so the sentence streamer for /api/audio/speak-stream needs no core change.
    try:
        from tools import tts_streaming

        from .kokoro_tts import KokoroStreamer, KokoroTTSProvider

        ctx.register_tts_provider(KokoroTTSProvider())
        tts_streaming.register("kokoro")(KokoroStreamer)
    except Exception as exc:  # voice is optional; never break the rest of the plugin
        import logging

        logging.getLogger(__name__).warning("vyrse: Kokoro TTS unavailable: %s", exc)

    # Browsing in a dedicated, persistent VYRSE Chrome profile (started on demand).
    from .browser import ensure_browser

    ctx.register_hook("pre_tool_call", ensure_browser)

    # Private mode: block online tools (web, browser, Skills Hub, web images).
    from . import privacy

    ctx.register_hook("pre_tool_call", privacy.guard)

    # .gguf files pasted into the VYRSE models folder appear in Hermes' model list.
    from . import models_watch

    models_watch.start()

    # The "wairz" wake word (wake_word.provider: heed), torch-free port of the trained Heed model.
    from . import wake

    wake.register(ctx)
