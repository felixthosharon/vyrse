"""`vyrse_files`: find anything on the PC through the Windows Search index (instant, offline), then open it
or show it in Explorer. Programs and scripts are never started from here."""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from typing import Any, Dict

_SCRIPT = Path(__file__).resolve().parent / "files.ps1"

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_files",
    "description": (
        "Find files and folders on this PC instantly (Windows Search index, your user folders). action=find with "
        "query = words from the file name (e.g. 'gpu benchmark'), optional kind (document|pdf|image|video|audio|"
        "code|archive|folder), modified (today|week|month|year), in (downloads|desktop|documents|pictures|videos|"
        "music or a full folder path), content=true to also search inside documents. Results are ALWAYS newest first, so "
        "for 'latest/most recent/last' just take the first result; only set modified when the user names a period. "
        "action=open opens a found document/media/folder in its app; action=reveal shows it in Explorer. Use this "
        "instead of dir/Get-ChildItem searches. To read or summarise a found file, use the file tools on its path. "
        "action=organize sorts a messy folder's loose files into subfolders by type (in = downloads/desktop/… or a "
        "path; 'clean up / sort / organise my downloads'): VYRSE asks the user first, never deletes, and shows the result; "
        "action=undo_organize puts the last sort back."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["find", "open", "reveal", "organize", "undo_organize"]},
            "query": {"type": "string", "description": "find: words from the name (or content with content=true)"},
            "kind": {"type": "string", "enum": ["document", "pdf", "image", "video", "audio", "code", "archive", "folder"]},
            "modified": {"type": "string", "enum": ["today", "week", "month", "year"]},
            "in": {"type": "string", "description": "downloads, desktop, documents, pictures, videos, music or a full path"},
            "content": {"type": "boolean", "description": "also match words inside documents"},
            "limit": {"type": "integer", "description": "max results (default 15, max 40)"},
            "path": {"type": "string", "description": "open/reveal: the full path from a find result"},
            "confirmed": {"type": "boolean", "description": "organize: only true if the user already said yes out loud"},
        },
        "required": ["action"],
    },
}


def run(request: Dict[str, Any], timeout: int = 25) -> Dict[str, Any]:
    from hermes_cli._subprocess_compat import windows_hide_flags

    payload = base64.b64encode(json.dumps(request).encode("utf-8")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", str(_SCRIPT), "-Request", payload],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
        stdin=subprocess.DEVNULL, creationflags=windows_hide_flags(),
    )
    lines = [line for line in (result.stdout or "").splitlines() if line.strip().startswith("{")]
    if lines:
        return json.loads(lines[-1])
    detail = (result.stderr or result.stdout or "no output").strip().splitlines()
    return {"ok": False, "error": f"file search failed: {detail[0] if detail else 'unknown error'}"}


def handle(params: Dict[str, Any], **_: Any) -> str:
    if params.get("action") in ("organize", "undo_organize"):
        from . import organize

        try:
            if params["action"] == "undo_organize":
                where = params.get("in") or params.get("path")
                return json.dumps(organize.undo(organize.resolve(where) if where else None), ensure_ascii=False)
            return json.dumps(organize.organize(params.get("in") or params.get("path") or "downloads",
                                                confirmed=params.get("confirmed") is True), ensure_ascii=False)
        except Exception as exc:
            return json.dumps({"ok": False, "error": f"Couldn't sort that folder: {exc}"})
    keys = ("action", "query", "kind", "modified", "in", "content", "limit", "path")
    request = {k: params[k] for k in keys if params.get(k) not in (None, "")}
    try:
        result = run(request)
        # Nothing in that period: look again without the date, newest first, and say so.
        if request.get("action") == "find" and request.get("modified") and result.get("ok") and not result.get("count"):
            wider = run({k: v for k, v in request.items() if k != "modified"})
            if wider.get("ok") and wider.get("count"):
                wider["note"] = f"Nothing modified in the last {request['modified']}; these are the newest matches from any time."
                result = wider
        return json.dumps(result, ensure_ascii=False)
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": "Windows Search didn't answer in time."})
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"Couldn't search: {exc}"})
