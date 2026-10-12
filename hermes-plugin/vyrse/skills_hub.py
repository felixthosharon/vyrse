"""`vyrse_skills`: let Hermes find and install Skills Hub skills when one would help, with the user's OK.

Search uses Hermes' own hub search; install runs `hermes skills install <id> --yes` (Hermes' security scan
always applies) only after the user confirms in the VYRSE window.
"""
from __future__ import annotations

import json
import subprocess
import sys
from typing import Any, Dict

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_skills",
    "description": (
        "Search the ONLINE Skills Hub: a catalog of thousands of skills that are NOT installed yet (skills_list "
        "only shows the installed ones). Use it when no installed skill fits a task, or when the user asks for a "
        "new skill. action=search (query) lists candidates; action=install (identifier from search, reason = one "
        "sentence on how it helps) asks the user in VYRSE and installs only if they agree. Then use skill_view."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["search", "install"]},
            "query": {"type": "string", "description": "For search: what the task is about."},
            "identifier": {"type": "string", "description": "For install: the identifier from search results."},
            "reason": {"type": "string", "description": "For install: why it helps, shown to the user."},
        },
        "required": ["action"],
    },
}


def _search(query: str) -> Dict[str, Any]:
    from hermes_cli.web_routers.skills import _hub_sources
    from tools.skills_hub_search import parallel_search_sources

    results, _counts, timed_out = parallel_search_sources(_hub_sources(None), query=query, source_filter="all",
                                                          overall_timeout=25)
    rank = {"builtin": 2, "trusted": 1, "community": 0}
    best: Dict[str, Any] = {}
    for r in results:
        if r.identifier not in best or rank.get(r.trust_level, 0) > rank.get(best[r.identifier].trust_level, 0):
            best[r.identifier] = r
    ordered = sorted(best.values(), key=lambda r: -rank.get(r.trust_level, 0))[:8]
    return {
        "success": True,
        "results": [{"identifier": r.identifier, "name": r.name, "description": (r.description or "")[:160],
                     "trust": r.trust_level} for r in ordered],
        **({"note": f"some sources timed out: {timed_out}"} if timed_out else {}),
    }


def _install(identifier: str, reason: str) -> Dict[str, Any]:
    from . import confirm

    name = identifier.rsplit("/", 1)[-1]
    question = f"Add the \"{name}\" skill? {reason}".strip()
    choice = confirm.ask(question, ["Install", "Not now"])
    if choice != "Install":
        return {"success": False, "declined": True, "message": "The user didn't approve installing it. Continue without it."}
    from hermes_cli._subprocess_compat import windows_hide_flags

    proc = subprocess.run(
        [sys.executable, "-m", "hermes_cli.main", "skills", "install", identifier, "--yes"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
        stdin=subprocess.DEVNULL, creationflags=windows_hide_flags(),
    )
    tail = "\n".join((proc.stdout or proc.stderr or "").strip().splitlines()[-6:])
    if proc.returncode != 0:
        return {"success": False, "error": f"Install failed: {tail}"}
    return {"success": True, "installed": name, "output": tail, "next": f"skill_view('{name}') to use it"}


def handle(params: Dict[str, Any], **_: Any) -> str:
    try:
        if params.get("action") == "search":
            query = str(params.get("query") or "").strip()
            if not query:
                return json.dumps({"success": False, "error": "query is required"})
            return json.dumps(_search(query), ensure_ascii=False)
        if params.get("action") == "install":
            identifier = str(params.get("identifier") or "").strip()
            if not identifier:
                return json.dumps({"success": False, "error": "identifier is required (from search)"})
            return json.dumps(_install(identifier, str(params.get("reason") or "")), ensure_ascii=False)
        return json.dumps({"success": False, "error": "action must be search or install"})
    except Exception as exc:
        return json.dumps({"success": False, "error": f"Skills Hub unavailable: {exc}"})
