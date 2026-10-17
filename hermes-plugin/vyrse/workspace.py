"""`vyrse_workspace`: Hermes puts things in VYRSE's workspace panel instead of describing them in text.

Only typed data crosses over (series, rows, code, an image, markdown…); VYRSE decides how it looks. Items
have an id, so showing the same id again updates it in place (e.g. a live CPU chart). Local image files
and web images are inlined as data URLs, since the window only displays images it was handed.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

KINDS = ("chart", "table", "markdown", "image", "code", "timeline", "steps", "status", "progress",
         "rings", "stats", "checklist", "quiz", "scorecard", "flashcards",
         "gauges", "cards", "weather", "timer", "board", "heatmap", "app", "picker", "mindmap", "form")
_MAX_IMAGE_BYTES = 6 * 1024 * 1024
_MAX_ROWS = 500
_MAX_POINTS = 400
_MAX_TEXT = 60_000
_MAX_APP = 200_000
# Icons a card can name (VYRSE draws its own; anything else gets a plain dot).
ICONS = ("sun", "cloud", "rain", "snow", "wind", "storm", "calendar", "clock", "news", "mail", "music", "game",
         "cpu", "gpu", "memory", "disk", "battery", "wifi", "shield", "check", "alert", "heart", "fire", "star",
         "book", "money", "cart", "food", "phone", "home", "trophy", "rocket", "idea", "user", "map", "chart",
         "code", "bug", "plane", "gym", "sleep", "study", "up", "down")

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_workspace",
    "description": (
        "Show things in VYRSE's workspace panel beside the chat when they're better SEEN than read: analysis, "
        "numbers, comparisons, logs, plans, monitoring, study material. Not for chit-chat or a one-line answer. "
        "Combine a few items into a dashboard. Pick the picture that fits, a table only for several columns of "
        "text: parts of a whole (spending, time) = donut; change over time = line; compare amounts = bar; % of "
        "a limit or goal (CPU, RAM, disk, battery, goals) = rings or gauges, never a donut; headline numbers = "
        "stats. Kinds: chart (line/bar/donut; "
        "highlight = the label to call out, threshold = a limit line), table (highlight = a row's first cell), "
        "stats (big numbers; change like '+12%'; trend = recent numbers for a sparkline), gauges (meters for "
        "temps/usage/levels; warn = the level that turns it red), rings (goals, done vs total), cards (a few "
        "icon cards: a briefing, a summary, pros/cons, tips), weather, timer (a focus countdown in minutes, or a "
        "countdown to a date with until), picker (a wheel that spins and picks one of the items at random: 'pick "
        "for me', coin flips, dice; never pick yourself), mindmap (title = the centre; outline = an indented list of branches and their sub-points), "
        "checklist (to-dos the user ticks), board (kanban: items with group, e.g. To do/Doing/Done), heatmap "
        "(a value per day, habits/activity), timeline, steps (done = ticked), status, progress, markdown "
        "(reports), code (lines = line numbers to highlight, e.g. the bug), image, quiz/scorecard, flashcards "
        "(cards = one per line 'question :: answer'; to quiz the user live use vyrse_quiz), app (a small interactive page you write yourself in one "
        "self-contained HTML file with CSS/JS: calculators, converters, simulations, mini games, custom "
        "visuals; no internet; theme colours as CSS vars --bg --fg --muted --primary --accent --success "
        "--card --border). For tracking/logging use vyrse_log. Never draw ASCII charts or open an external "
        "viewer. action=show (same id updates in place, e.g. re-show id='gpu' gauges every few seconds); "
        "remove (id); clear; focus (id: show just that item, big; no id = show all); "
        "layout (split|focus|compact; focus makes the workspace the main view). Interactive: buttons on ANY item "
        "(lines 'Label :: what tapping it tells you', e.g. 'Make it cheaper :: Make the plan cheaper') come back to you "
        "as the user's message; form (fields = lines 'Label :: text|number|date|time|select :: options a/b/c'; submit = "
        "button text) asks the user for details on screen and sends you what they filled in."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["show", "remove", "clear", "focus", "layout"]},
            "id": {"type": "string", "description": "Stable id for the item; same id = update in place."},
            "kind": {"type": "string", "enum": list(KINDS)},
            "title": {"type": "string"},
            "caption": {"type": "string", "description": "One short line under the item."},
            "points": {
                "type": "array",
                "description": "kind=chart: [{label, value}] in order (e.g. time labels and numbers).",
                "items": {"type": "object", "properties": {"label": {"type": "string"}, "value": {"type": "number"}}},
            },
            "style": {"type": "string", "enum": ["line", "bar", "donut"], "description": "kind=chart. Default line; bar to compare; donut for parts of a whole."},
            "unit": {"type": "string", "description": "Unit for values, e.g. '%', '°C', 'MB', 'min'."},
            "highlight": {"type": "string", "description": "kind=chart: the point label to call out (e.g. the peak); kind=table: first cell of the row to call out."},
            "threshold": {"type": "number", "description": "kind=chart: a limit drawn as a dashed line (e.g. 80 for 80°C)."},
            "columns": {"type": "array", "items": {"type": "string"}, "description": "kind=table."},
            "rows": {"type": "array", "items": {"type": "array"}, "description": "kind=table: rows of cells."},
            "markdown": {"type": "string", "description": "kind=markdown: the document text (Markdown)."},
            "path": {"type": "string", "description": "kind=image: local image file (png, jpg, gif, webp, svg)."},
            "url": {"type": "string", "description": "kind=image: https image URL (alternative to path)."},
            "code": {"type": "string", "description": "kind=code."},
            "language": {"type": "string", "description": "kind=code."},
            "lines": {"type": "array", "items": {"type": "integer"}, "description": "kind=code: line numbers to highlight."},
            "html": {"type": "string", "description": "kind=app: one complete HTML document (inline <style> and <script>, no external files)."},
            "cards": {"type": "string", "description": "kind=flashcards: one card per line, 'front :: back', e.g. "
                                                       "\"What is SN2? :: One-step substitution with backside attack\""},
            "outline": {"type": "string", "description": "kind=mindmap: the branches and their sub-points as an indented list, "
                                                         "e.g. \"- Inputs\\n  - Sunlight\\n  - Water\\n- Outputs\\n  - Glucose\""},
            "minutes": {"type": "number", "description": "kind=timer: countdown length."},
            "until": {"type": "string", "description": "kind=timer: count down to a date/time instead, e.g. 2026-10-19 or 2026-10-19T09:00."},
            "location": {"type": "string", "description": "kind=weather: the place."},
            "condition": {"type": "string", "description": "kind=weather: e.g. 'Overcast'."},
            "high": {"type": "number", "description": "kind=weather: today's high."},
            "low": {"type": "number", "description": "kind=weather: today's low."},
            "items": {
                "type": "array",
                "description": "kind=timeline: [{at, label, detail?}]; kind=steps: [{label, note?, done?}]; "
                               "kind=status: [{label, value}]; kind=rings: [{label, value (done so far), max (the "
                               "target), unit?}]; "
                               "kind=stats: [{label, value, change?, note?, trend?}]; kind=gauges: [{label, "
                               "value, max?, unit?, warn?}]; kind=cards: [{label, detail, value?, icon?}] (icon: "
                               + ", ".join(ICONS) + "); kind=checklist: [{label, done}]; kind=board: [{label, "
                               "group, note?}]; kind=picker: [{label}] (the options); kind=mindmap: one per branch "
                               "[{label, children: [sub-point, ...]}]; kind=heatmap: [{label (a date or name), value}]; kind=weather: "
                               "forecast [{at (day), label (condition), value (temp)}]; "
                               "kind=quiz: [{question, answer?, correct? (true/false; omit if not answered yet), "
                               "right_answer?, note?}]; kind=scorecard: per-topic [{label, value 0..1, weak?}]; "
                               "kind=flashcards: [{front, back}] (or use cards).",
                # Fields spelled out: a bare object schema makes local models' grammar emit empty {} items.
                "items": {"type": "object", "properties": {
                    "label": {"type": "string"},
                    "value": {"type": ["number", "string"]},
                    "max": {"type": "number"},
                    "unit": {"type": "string"},
                    "change": {"type": "string"},
                    "note": {"type": "string"},
                    "done": {"type": "boolean"},
                    "weak": {"type": "boolean"},
                    "at": {"type": "string"},
                    "detail": {"type": "string"},
                    "question": {"type": "string"},
                    "answer": {"type": "string"},
                    "correct": {"type": "boolean"},
                    "right_answer": {"type": "string"},
                    "front": {"type": "string"},
                    "back": {"type": "string"},
                    "icon": {"type": "string"},
                    "group": {"type": "string"},
                    "warn": {"type": "number"},
                    "trend": {"type": "array", "items": {"type": "number"}},
                    "children": {"type": "array", "items": {"type": "string"}},
                }},
            },
            "value": {"type": "number", "description": "kind=progress: 0..1."},
            "score": {"type": "number", "description": "kind=scorecard: points scored."},
            "total": {"type": "number", "description": "kind=scorecard: points possible."},
            "verdict": {"type": "string", "description": "kind=scorecard: a few words, e.g. 'Solid. One gap.'"},
            "review": {"type": "string", "description": "kind=scorecard: what to revise next."},
            "message": {"type": "string", "description": "kind=progress."},
            "subject": {"type": "string", "description": "kind=quiz/scorecard: e.g. 'Physics · Unit 3'."},
            "buttons": {"type": "string", "description": "Any kind: up to 4 lines 'Label :: message sent to you when tapped'."},
            "fields": {"type": "string", "description": "kind=form: one per line 'Label :: type :: options' (type text|number|date|time|select)."},
            "submit": {"type": "string", "description": "kind=form: the button text, e.g. 'Plan it'."},
            "layout": {"type": "string", "enum": ["split", "focus", "compact"]},
            "focus": {"type": "boolean", "description": "action=show: also show this item on its own, big."},
        },
        "required": ["action"],
    },
}


def _err(message: str) -> str:
    return json.dumps({"success": False, "error": message})


def _text(value: Any, limit: int = 200) -> str:
    return str(value if value is not None else "")[:limit]


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", value.lower()).strip("-")[:48] or "item"


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip().rstrip("%"))
    except (TypeError, ValueError):
        return None


# kind -> field names for a positional row, e.g. rings ["Physics", 45, 60] = label, value, max.
_ROW_FIELDS = {
    "rings": ("label", "value", "max", "unit"),
    "stats": ("label", "value", "change", "note"),
    "checklist": ("label", "done"),
    "quiz": ("question", "answer", "correct", "right_answer"),
    "scorecard": ("label", "value", "weak"),
    "flashcards": ("front", "back"),
    "timeline": ("at", "label", "detail"),
    "steps": ("label", "note", "done"),
    "status": ("label", "value"),
    "gauges": ("label", "value", "max", "unit", "warn"),
    "cards": ("label", "detail", "value", "icon"),
    "board": ("label", "group", "note"),
    "picker": ("label",),
    "mindmap": ("label", "group", "detail"),
    "heatmap": ("label", "value"),
    "weather": ("at", "label", "value"),
}


def _truthy(value: Any) -> bool:
    return value is True or str(value).strip().lower() in ("true", "yes", "done", "1")


def _items(p: Dict[str, Any], limit: int) -> List[Dict[str, Any]]:
    """`items` as dicts; models sometimes send `rows` (lists) or bare strings instead, so map those too."""
    fields = _ROW_FIELDS.get(str(p.get("kind")), ("label",))
    out: List[Dict[str, Any]] = []
    # Table-shaped numbers (columns = labels, one row = values) for a kind that wants label/value items.
    cols, rows = p.get("columns"), p.get("rows")
    if (not p.get("items") and p.get("kind") in ("stats", "status", "gauges", "rings") and isinstance(cols, list)
            and isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], list) and len(rows[0]) == len(cols)):
        return [{"label": c, "value": v, **({"unit": p["unit"]} if p.get("unit") and p.get("kind") != "stats" else {})}
                for c, v in zip(cols, rows[0])][:limit]
    raw = [i for i in (p.get("items") or []) if i not in ({}, None)] or (p.get("rows") or [])
    if not raw and p.get("kind") in ("stats", "status", "gauges", "rings", "heatmap", "quiz"):
        raw = [i for i in (p.get("points") or []) if isinstance(i, dict)]  # chart-shaped label/value points
    for i in raw[:limit]:
        if isinstance(i, dict):
            out.append(i)
        elif isinstance(i, (list, tuple)):
            out.append({k: v for k, v in zip(fields, i)})
        elif isinstance(i, str) and i.strip():
            out.append({fields[0]: i})
    if p.get("unit"):
        for i in out:
            i.setdefault("unit", p["unit"])
    return out


def _image_data_url(path: Optional[str], url: Optional[str]) -> str:
    if path:
        file = Path(path).expanduser()
        if not file.is_file():
            raise ValueError(f"no image file at {path}")
        data = file.read_bytes()
        mime = mimetypes.guess_type(file.name)[0] or "image/png"
    elif url:
        if not url.lower().startswith("https://"):
            raise ValueError("image url must be https")
        import urllib.request

        req = urllib.request.Request(url, headers={"User-Agent": "VYRSE"})
        with urllib.request.urlopen(req, timeout=20) as res:  # noqa: S310 (https only, checked above)
            mime = (res.headers.get_content_type() or "image/png")
            data = res.read(_MAX_IMAGE_BYTES + 1)
    else:
        raise ValueError("kind=image needs path or url")
    if not mime.startswith("image/"):
        raise ValueError(f"not an image ({mime})")
    if len(data) > _MAX_IMAGE_BYTES:
        raise ValueError("image is larger than 6 MB")
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _page_title(p: Dict[str, Any]) -> str:
    """kind=app without a title: the page's own <title> or first heading."""
    if p.get("kind") != "app":
        return ""
    m = re.search(r"<title[^>]*>(.*?)</title>|<h[12][^>]*>(.*?)</h[12]>", str(p.get("html") or ""), re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", (m.group(1) or m.group(2)) if m else "")
    return re.sub(r"\s+", " ", text).strip()


def pairs_from_text(text: str, parts: int = 2) -> List[List[str]]:
    """Lines like 'Q :: A' (also 'Q | A', 'Q — A', 'Q: … A: …', 'Q? A') -> [[Q, A], …]; with parts=3 a third
    field (e.g. a topic) is kept when present."""
    out: List[List[str]] = []
    # Sometimes the lines arrive wrapped in a JSON list ('["Q :: A", "Q :: A"]').
    if text.strip().startswith("["):
        try:
            listed = json.loads(text)
            if isinstance(listed, list):
                text = "\n".join(str(x) for x in listed if isinstance(x, (str, int, float)))
        except ValueError:
            pass
    for raw in text.replace("\r", "").split("\n"):
        line = re.sub(r"^\s*(?:[-*+•]|\d+[.)])\s*", "", raw).strip().strip(",").strip().strip('"').strip("[]").strip('"').strip()
        if not line:
            continue
        m = re.match(r"^(?:Q(?:uestion)?\s*[:.]\s*)(.+?)\s+A(?:nswer)?\s*[:.]\s*(.+)$", line, re.I)
        if m:
            fields = [m.group(1), m.group(2)]
        else:
            fields = [f.strip() for f in re.split(r"\s*(?:::|\s\|\s|\s[—–]\s)\s*", line) if f.strip()]
            if len(fields) == 1 and "?" in line[:-1]:  # "What is X? the answer"
                q, _, a = line.partition("?")
                fields = [q + "?", a.strip()] if a.strip() else fields
        if len(fields) >= 2:
            out.append(fields[:parts] if parts > 2 else [fields[0], " — ".join(fields[1:])])
    return out


def _outline(text: str) -> List[Any]:
    """An indented list ("- Inputs" / "  - Sunlight") or "Inputs: Sunlight, Water" lines -> [(branch, [leaves])]."""
    out: List[Any] = []
    for raw in text.replace("\r", "").split("\n"):
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" \t"))
        line = re.sub(r"^[-*+•]\s*|^\d+[.)]\s*|^#+\s*", "", raw.strip()).strip().strip("*").strip()
        if not line:
            continue
        if indent == 0 or not out:
            head, _, rest = line.partition(":")
            kids = [k.strip() for k in rest.split(",") if k.strip()] if rest.strip() and len(head) <= 40 else []
            out.append((_text(head if kids else line, 40), [_text(k, 60) for k in kids]))
        else:
            out[-1][1].append(_text(line, 60))
    return out


def build_artifact(p: Dict[str, Any]) -> Dict[str, Any]:
    """Validated, size-capped artifact in the shape VYRSE renders. Raises ValueError on bad input."""
    kind = p.get("kind")
    # a chart style named as the kind ("donut", "pie", "bar", "line"): local models do this a lot
    if kind in ("donut", "pie", "bar", "line"):
        p = {**p, "kind": "chart", "style": p.get("style") or ("donut" if kind == "pie" else kind)}
        kind = "chart"
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    title = _text(p.get("title") or _page_title(p) or kind.title(), 120)
    art: Dict[str, Any] = {"id": _slug(str(p.get("id") or title)), "title": title}
    if p.get("caption"):
        art["caption"] = _text(p["caption"], 240)
    # Buttons on any item: tapping one sends its message to VYRSE as the user's.
    actions = []
    raw_buttons = p.get("buttons")
    lines = raw_buttons if isinstance(raw_buttons, list) else str(raw_buttons or "").splitlines()
    for line in lines[:4]:
        if isinstance(line, dict):
            label, prompt = _text(line.get("label"), 40), _text(line.get("prompt") or line.get("message") or line.get("label"), 300)
        else:
            parts = [x.strip() for x in str(line).split("::", 1)]
            label, prompt = _text(parts[0].lstrip("-*• ").strip(), 40), _text(parts[-1], 300)
        if label and prompt:
            actions.append({"label": label, "prompt": prompt})
    if actions:
        art["actions"] = actions
    if kind == "chart":
        points: List[Dict[str, Any]] = []
        for pt in (p.get("points") or [])[:_MAX_POINTS]:
            if isinstance(pt, dict) and isinstance(pt.get("value"), (int, float)):
                points.append({"label": _text(pt.get("label"), 24), "value": float(pt["value"])})
        if not points:
            raise ValueError("kind=chart needs points: [{label, value}]")
        style = p.get("style") if p.get("style") in ("bar", "donut") else "line"
        chart: Dict[str, Any] = {"style": style}
        if p.get("unit"):
            chart["unit"] = _text(p["unit"], 12)
        wanted = str(p.get("highlight") or "").strip().lower()
        if wanted and any(pt["label"].lower() == wanted for pt in points):
            chart["highlight"] = next(pt["label"] for pt in points if pt["label"].lower() == wanted)
        if _num(p.get("threshold")) is not None:
            chart["threshold"] = _num(p["threshold"])
        art.update(kind="series", series=points, chart=chart)
    elif kind == "table":
        columns = [_text(c, 60) for c in (p.get("columns") or [])][:20]
        rows = [[c if isinstance(c, (int, float)) else _text(c, 300) for c in r][:20]
                for r in (p.get("rows") or [])[:_MAX_ROWS] if isinstance(r, list)]
        if not columns or not rows:
            raise ValueError("kind=table needs columns and rows")
        table: Dict[str, Any] = {"columns": columns, "rows": rows}
        wanted = str(p.get("highlight") or "").strip().lower()
        hit = next((n for n, r in enumerate(rows) if r and str(r[0]).strip().lower() == wanted), None) if wanted else None
        if hit is not None:
            table["highlight"] = hit
        art.update(kind="table", table=table)
    elif kind == "markdown":
        text = str(p.get("markdown") or "")
        if not text.strip():
            raise ValueError("kind=markdown needs markdown text")
        art.update(kind="markdown", markdown=text[:_MAX_TEXT])
    elif kind == "image":
        art.update(kind="image", image={"dataUrl": _image_data_url(p.get("path"), p.get("url")), "alt": title})
    elif kind == "code":
        if not p.get("code"):
            raise ValueError("kind=code needs code")
        code = {"code": str(p["code"])[:_MAX_TEXT], "language": _text(p.get("language"), 24)}
        lines = sorted({int(n) for n in (p.get("lines") or []) if _num(n) is not None and 0 < _num(n) < 100_000})[:50]
        if lines:
            code["highlight"] = lines
        art.update(kind="code", code=code)
    elif kind == "timeline":
        items = [{"at": _text(i.get("at"), 40), "label": _text(i.get("label"), 160),
                  **({"detail": _text(i["detail"], 300)} if i.get("detail") else {})}
                 for i in _items(p, 200)]
        if not items:
            raise ValueError("kind=timeline needs items: [{at, label}]")
        art.update(kind="timeline", timeline=items)
    elif kind == "steps":
        items = [{"id": str(n), "label": _text(i.get("label"), 120), **({"note": _text(i["note"], 160)} if i.get("note") else {}),
                  **({"done": _truthy(i["done"])} if i.get("done") not in (None, "") else {})}
                 for n, i in enumerate(_items(p, 20))]
        if not items:
            raise ValueError("kind=steps needs items: [{label}]")
        art.update(kind="flow", flow=items)
    elif kind == "status":
        values = [{"label": _text(i.get("label"), 60), "value": _text(i.get("value"), 120)}
                  for i in _items(p, 24)]
        if not values:
            raise ValueError("kind=status needs items: [{label, value}]")
        art.update(kind="system_status", system_status={"title": title, "values": values})
    elif kind == "progress":
        art.update(kind="progress", progress={
            "label": title,
            **({"value": max(0.0, min(1.0, float(p["value"])))} if isinstance(p.get("value"), (int, float)) else {}),
            **({"message": _text(p["message"], 200)} if p.get("message") else {}),
        })
    elif kind == "rings":
        rings = []
        # Goals sent as items {label, value: target} plus points {label, value: done} (Qwen did this): pair them up.
        # (Only when both came: points alone are the rings themselves, e.g. CPU 13% -> 13 of 100.)
        done_so_far = {str(pt.get("label")).lower(): _num(pt.get("value")) for pt in (p.get("points") or []) if isinstance(pt, dict)} if p.get("items") else {}
        targetless = True
        for i in _items(p, 6):
            value, top = _num(i.get("value")), _num(i.get("max"))
            if value is None:
                continue
            paired = done_so_far.get(str(i.get("label")).lower())
            if top is None and paired is not None and paired <= value:
                value, top = paired, value
            targetless = targetless and not (top and top > 0)
            top = top if top and top > 0 else (100.0 if value > 1 else 1.0)
            rings.append({"label": _text(i.get("label"), 40), "value": value, "max": top,
                          **({"unit": _text(i["unit"], 12)} if i.get("unit") else {})})
        if not rings:
            raise ValueError("kind=rings needs items: [{label, value, max}]")
        unit = str(p.get("unit") or rings[0].get("unit") or "")
        if targetless and (any(r["value"] > 100 for r in rings) or re.search(r"[$₹€£]|rs\b|inr|usd", unit, re.I)):
            # Amounts with no target (spending 200, 150, 500…) aren't progress: they're parts of a whole.
            art.update(kind="series", series=[{"label": r["label"][:24], "value": r["value"]} for r in rings],
                       chart={"style": "donut", **({"unit": _text(unit, 12)} if unit and unit != "%" else {})})
        else:
            art.update(kind="rings", rings=rings)
    elif kind == "stats":
        stats = []
        for i in _items(p, 8):
            if i.get("value") in (None, ""):
                continue
            change = i.get("change") if i.get("change") not in (None, "") else i.get("delta")
            trend = [v for v in (_num(t) for t in (i.get("trend") or [])[-60:] if isinstance(i.get("trend"), list)) if v is not None]
            stats.append({"label": _text(i.get("label"), 40), "value": _text(i["value"], 24),
                          **({"change": _text(change, 16)} if change not in (None, "") else {}),
                          **({"note": _text(i["note"], 80)} if i.get("note") else {}),
                          **({"trend": trend} if len(trend) >= 2 else {})})
        if not stats:
            raise ValueError("kind=stats needs items: [{label, value}]")
        art.update(kind="stats", stats=stats)
    elif kind == "checklist":
        checks = [{"label": _text(i.get("label") or i.get("text"), 160), "done": i.get("done") is True or str(i.get("done")).lower() in ("true", "yes", "done", "1")}
                  for i in _items(p, 50) if i.get("label") or i.get("text")]
        if not checks:
            raise ValueError("kind=checklist needs items: [{label, done}]")
        art.update(kind="checklist", checklist=checks)
    elif kind == "quiz":
        qs = []
        for i in _items(p, 30):
            # local models label questions every which way; take whichever text field they used
            text = next((i[k] for k in ("question", "q", "label", "text", "front", "prompt") if isinstance(i.get(k), str) and i[k].strip()), "")
            if not text:
                continue
            q: Dict[str, Any] = {"question": _text(text, 300)}
            if i.get("answer") not in (None, ""):
                q["answer"] = _text(i["answer"], 200)
            # Only an answered question can be marked (and only then is the right answer shown).
            if "answer" in q and isinstance(i.get("correct"), bool):
                q["correct"] = i["correct"]
                for key, limit in (("right_answer", 200), ("note", 300)):
                    if i.get(key):
                        q[key] = _text(i[key], limit)
            qs.append(q)
        if not qs:
            raise ValueError("kind=quiz needs items: [{question, answer?, correct?}]")
        art.update(kind="quiz", quiz={"questions": qs, **({"subject": _text(p["subject"], 60)} if p.get("subject") else {})})
    elif kind == "scorecard":
        score, total = _num(p.get("score")), _num(p.get("total"))
        if score is None or not total or total <= 0:
            raise ValueError("kind=scorecard needs score and total")
        topics = []
        for i in _items(p, 12):
            v = _num(i.get("value"))
            if v is None:
                continue
            v = v / 100 if v > 1 else v
            topics.append({"label": _text(i.get("label"), 60), "value": max(0.0, min(1.0, v)), "weak": bool(i.get("weak"))})
        art.update(kind="scorecard", scorecard={
            "score": score, "total": total, "topics": topics,
            **{k: _text(p[k], lim) for k, lim in (("verdict", 60), ("subject", 60), ("review", 200)) if p.get(k)},
        })
    elif kind == "flashcards":
        cards = []
        raw = _items(p, 60) or [i for i in (p.get("points") or []) if isinstance(i, dict)][:60]
        for i in raw:
            # whichever names the model used: front/back, question/answer, term/definition, or one "Q :: A" label
            front = next((i[k] for k in ("front", "question", "q", "term", "label") if isinstance(i.get(k), str) and i[k].strip()), "")
            back = next((i[k] for k in ("back", "answer", "a", "definition") if isinstance(i.get(k), str) and i[k].strip()), "")
            if front and not back and "::" in front:
                front, back = (x.strip() for x in front.split("::", 1))
            if front and back:
                cards.append({"front": _text(front, 300), "back": _text(back, 600)})
        # Small models do far better writing lines of text than nested objects ('front :: back').
        cards += [{"front": _text(f, 300), "back": _text(b, 600)} for f, b in pairs_from_text(str(p.get("cards") or p.get("markdown") or ""))][: 60 - len(cards)]
        if not cards:
            raise ValueError("kind=flashcards needs cards: one per line, like \"What is SN2? :: One-step substitution\\n"
                             "What is chirality? :: Non-superimposable mirror images\"")
        art.update(kind="flashcards", flashcards=cards)
    elif kind == "form":
        fields = []
        for line in str(p.get("fields") or "").splitlines()[:10]:
            parts = [x.strip() for x in line.lstrip("-*• ").split("::")]
            label = _text(parts[0], 60) if parts else ""
            if not label:
                continue
            ftype = (parts[1].lower() if len(parts) > 1 else "text")
            ftype = ftype if ftype in ("text", "number", "date", "time", "select") else "text"
            field: Dict[str, Any] = {"label": label, "type": ftype}
            if len(parts) > 2 and parts[2]:
                if ftype == "select":
                    field["options"] = [_text(o, 40) for o in re.split(r"[/,|]", parts[2]) if o.strip()][:12]
                else:
                    field["placeholder"] = _text(parts[2], 60)
            fields.append(field)
        if not fields:
            raise ValueError("kind=form needs fields: lines 'Label :: type :: options'")
        art.update(kind="form", form={"fields": fields, "submit": _text(p.get("submit") or "Send", 30)})
    elif kind == "gauges":
        gauges = []
        for i in _items(p, 6):
            value, top, warn = _num(i.get("value")), _num(i.get("max")), _num(i.get("warn"))
            if value is None:
                continue
            gauges.append({"label": _text(i.get("label"), 40), "value": value, "max": top if top and top > 0 else 100.0,
                           **({"unit": _text(i["unit"], 12)} if i.get("unit") else {}),
                           **({"warn": warn} if warn is not None else {})})
        if not gauges:
            raise ValueError("kind=gauges needs items: [{label, value, max?, unit?, warn?}]")
        art.update(kind="gauges", gauges=gauges)
    elif kind == "cards":
        cards = []
        for i in _items(p, 8):
            head, body = i.get("label") or i.get("title") or i.get("group"), i.get("detail") or i.get("note") or i.get("text")
            if not head and not body:
                continue
            icon = str(i.get("icon") or "").strip().lower()
            cards.append({"label": _text(head, 60), "detail": _text(body, 400),
                          **({"value": _text(i["value"], 24)} if i.get("value") not in (None, "") else {}),
                          **({"icon": icon} if icon in ICONS else {})})
        if not cards:
            raise ValueError("kind=cards needs items: [{label, detail, icon?}]")
        art.update(kind="cards", cards=cards)
    elif kind == "weather":
        temp = _num(p.get("value") if p.get("value") is not None else p.get("temp"))
        if temp is None:
            raise ValueError("kind=weather needs value (the temperature now)")
        forecast = [{"at": _text(i.get("at") or i.get("label"), 16), "label": _text(i.get("label"), 40),
                     "value": _num(i.get("value"))} for i in _items(p, 7) if _num(i.get("value")) is not None]
        art.update(kind="weather", weather={
            "location": _text(p.get("location") or title, 60), "condition": _text(p.get("condition") or p.get("message"), 60),
            "temp": temp, "unit": _text(p.get("unit") or "°", 4),
            **{k: _num(p[k]) for k in ("high", "low") if _num(p.get(k)) is not None},
            **({"forecast": forecast} if forecast else {}),
        })
    elif kind == "timer":
        import time
        from datetime import datetime

        minutes = _num(p.get("minutes"))
        if p.get("until"):
            try:
                end = datetime.fromisoformat(str(p["until"]).strip().replace("Z", "+00:00"))
            except ValueError:
                raise ValueError("kind=timer until must be a date like 2026-10-19 or 2026-10-19T09:00")
            seconds = end.timestamp() - time.time()
            if not 0 < seconds <= 3 * 365 * 86400:
                raise ValueError("kind=timer until must be in the future (within 3 years)")
        elif minutes is not None and 0 < minutes <= 24 * 60:
            seconds = minutes * 60
        else:
            raise ValueError("kind=timer needs minutes (up to a day) or until (a date)")
        art.update(kind="timer", timer={"label": title, "ends_at": int((time.time() + seconds) * 1000), "seconds": int(seconds)})
    elif kind == "board":
        groups: Dict[str, List[Dict[str, Any]]] = {}
        for i in _items(p, 60):
            # Models also send a column with its cards as children ({group, children: [...]}) or a card with
            # sub-steps ({label, group, children}): both become cards rather than an error.
            children = [c for c in (i.get("children") or []) if isinstance(c, str) and c.strip()]
            if not i.get("label") and not children:
                continue
            group = _text(i.get("group") or i.get("status") or (i.get("label") if children and not i.get("group") else "") or "To do", 30)
            if group not in groups and len(groups) >= 6:
                continue
            if i.get("label") and (i.get("group") or not children):
                note = i.get("note") or (", ".join(children)[:160] if children else "")
                groups.setdefault(group, []).append({"label": _text(i["label"], 160), **({"note": _text(note, 160)} if note else {})})
            else:
                groups.setdefault(group, []).extend({"label": _text(c, 160)} for c in children[:20])
        if not groups:
            raise ValueError("kind=board needs items: [{label, group}]")
        art.update(kind="board", board=[{"name": g, "cards": c} for g, c in groups.items()])
    elif kind == "heatmap":
        cells = [{"label": _text(i.get("label") or i.get("at"), 24), "value": _num(i.get("value"))}
                 for i in _items(p, 371) if _num(i.get("value")) is not None]
        if not cells:
            raise ValueError("kind=heatmap needs items: [{label, value}]")
        art.update(kind="heatmap", heatmap={"cells": cells, **({"unit": _text(p["unit"], 12)} if p.get("unit") else {})})
    elif kind == "picker":
        options = list(dict.fromkeys(_text(i.get("label") or i.get("value") or i.get("front"), 40).strip()
                                     for i in _items(p, 24)))
        options = [o for o in options if o]
        if len(options) < 2:
            raise ValueError("kind=picker needs at least 2 items: [{label}] (the options to pick from)")
        art.update(kind="picker", picker={"options": options})
    elif kind == "mindmap":
        # Small models send this many ways: leaves without a label (text in detail), branches alone (group
        # only, or label == group), lowercase branch names. Take whatever shape arrives rather than refuse it.
        branches: Dict[str, List[Dict[str, Any]]] = {}
        names: Dict[str, str] = {}  # lowercase -> how the branch is shown
        for i in _items(p, 40):
            # The natural shape: one item per branch with its sub-points in children.
            kids = [_text(c, 60) for c in (i.get("children") or []) if isinstance(c, str) and c.strip()] if isinstance(i.get("children"), list) else []
            if kids:
                branch = _text(i.get("label") or i.get("group"), 40)
                if branch:
                    key = branch.lower()
                    if key not in names and len(names) < 8:
                        names[key] = branch[:1].upper() + branch[1:]
                        branches[key] = []
                    if key in branches:
                        branches[key].extend({"label": k} for k in kids[: 6 - len(branches[key])])
                    continue
            label = _text(i.get("label") or i.get("detail") or i.get("note"), 60)
            group = _text(i.get("group") or i.get("at"), 40) or label
            if not group:
                continue
            key = group.lower()
            if key not in names:
                if len(names) >= 8:
                    continue
                names[key] = group[:1].upper() + group[1:]
                branches[key] = []
            leaves = branches[key]
            if label and label.lower() != key and len(leaves) < 6:
                detail = _text(i.get("detail"), 120)
                leaves.append({"label": label, **({"detail": detail} if detail and detail != label else {})})
        for branch, kids in _outline(str(p.get("outline") or p.get("markdown") or "")):
            key = branch.lower()
            if key not in names:
                if len(names) >= 8:
                    continue
                names[key] = branch[:1].upper() + branch[1:]
                branches[key] = []
            branches[key].extend({"label": k} for k in kids[: max(0, 6 - len(branches[key]))])
        if not branches:  # chart-shaped points: at least the branches
            for pt in (p.get("points") or [])[:8]:
                label = _text(pt.get("label"), 40) if isinstance(pt, dict) else ""
                if label and label.lower() not in names:
                    names[label.lower()] = label
                    branches[label.lower()] = []
        if not branches:
            raise ValueError("kind=mindmap needs outline: an indented list like \"- Inputs\\n  - Sunlight\\n  - Water\\n"
                             "- Outputs\\n  - Glucose\" (title = the centre)")
        art.update(kind="mindmap", mindmap={"center": title, "branches": [{"label": names[k], "leaves": l} for k, l in branches.items()]})
    elif kind == "app":
        html = str(p.get("html") or p.get("code") or p.get("markdown") or "")
        if "<" not in html:
            raise ValueError("kind=app needs html: one complete HTML document")
        if len(html) > _MAX_APP:
            raise ValueError("kind=app html is too big (keep it under 200 KB)")
        art.update(kind="app", app={"html": html})
    return art


def handle(params: Dict[str, Any], **_: Any) -> str:
    from .tools import _in_vyrse_session

    if not _in_vyrse_session():
        return _err("vyrse_workspace only works in the VYRSE desktop app.")
    action = params.get("action")
    try:
        if action == "show":
            artifact = build_artifact(params)
            payload: Dict[str, Any] = {"action": "workspace", "op": "show", "artifact": artifact}
            if params.get("layout") in ("split", "focus"):
                payload["layout"] = params["layout"]
            if params.get("focus") is True:
                payload["focus"] = True
            done = (f"showing '{artifact['title']}' in the workspace (id {artifact['id']}). The user sees it: reply with just "
                    "the headline in a sentence or two (the finding, total or verdict), never a list of what it shows")
            if artifact["kind"] == "timer":
                done += "; it counts down on screen by itself, no need to update it"
            if artifact["kind"] == "mindmap" and not any(b["leaves"] for b in artifact["mindmap"]["branches"]):
                done += (f". It only has branches so far: show id '{artifact['id']}' again with each branch's sub-points, "
                         'items like {"label": "' + artifact["mindmap"]["branches"][0]["label"] + '", "children": ["…", "…"]}')
            if artifact["kind"] == "picker":
                done += ("; the wheel spins and picks on screen by itself: don't pick one yourself or run code, just "
                         "say it's spinning")
        elif action == "remove":
            if not params.get("id"):
                return _err("remove needs id")
            payload, done = {"action": "workspace", "op": "remove", "id": _slug(str(params["id"]))}, "removed"
        elif action == "clear":
            payload, done = {"action": "workspace", "op": "clear"}, "workspace cleared"
        elif action == "focus":
            target = _slug(str(params["id"])) if params.get("id") else ""
            payload = {"action": "workspace", "op": "focus", "id": target}
            done = f"showing only {target}" if target else "showing every item"
        elif action == "layout":
            if params.get("layout") not in ("split", "focus", "compact"):
                return _err("layout must be split, focus or compact")
            payload, done = {"action": "workspace", "op": "layout", "layout": params["layout"]}, f"layout {params['layout']}"
        else:
            return _err("action must be show, remove, clear, focus or layout")
    except ValueError as exc:
        return _err(str(exc))
    except Exception as exc:
        return _err(f"Couldn't prepare that for the workspace: {exc}")
    if not deliver(payload):
        return _err("The VYRSE window is not connected right now (saved to this conversation's workspace).")
    return json.dumps({"success": True, "result": done})


def deliver(payload: Dict[str, Any], *, persist: bool = True, session: str = "") -> bool:
    """Save to the current conversation's board (kept even if the window isn't connected), then send it
    to the VYRSE window. Returns whether the window received it. `persist=False` only sends (live updates)."""
    from gateway.session_context import get_session_env
    from tools import desktop_ui

    session_id = session or get_session_env("HERMES_SESSION_ID", "")
    if session_id:
        payload["session"] = session_id
    if session_id and persist:
        if payload["op"] == "show":
            store_show(session_id, payload["artifact"])
        elif payload["op"] == "remove":
            store_remove(session_id, payload["id"])
        elif payload["op"] == "clear":
            store_clear(session_id)
    return desktop_ui.emit("vyrse.ui", payload)


# --- per-conversation persistence ---------------------------------------------------------------------
# The board belongs to its conversation and survives restarts: %HERMES_HOME%/vyrse/workspace/<id>.json.
# Same merge rules as the app: same id, or the same data under another title/styling, replaces in place.
_MAX_ITEMS = 24


def _store_path(session_id: str) -> Optional[Path]:
    from hermes_constants import get_hermes_home

    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(session_id or ""))[:80]  # conversation ids: letters, digits, _ -
    if not safe:
        return None
    return Path(get_hermes_home()) / "vyrse" / "workspace" / f"{safe}.json"


def load_items(session_id: str) -> List[Dict[str, Any]]:
    path = _store_path(session_id)
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path and path.is_file() else []
        return [a for a in data if isinstance(a, dict)][:_MAX_ITEMS]
    except (OSError, ValueError):
        return []


def _save_items(session_id: str, items: List[Dict[str, Any]]) -> None:
    path = _store_path(session_id)
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if not items:
        path.unlink(missing_ok=True)
        return
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(items[:_MAX_ITEMS], ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _content_key(artifact: Dict[str, Any]) -> str:
    return json.dumps({k: v for k, v in artifact.items() if k not in ("id", "title", "caption", "chart")}, sort_keys=True)


def store_show(session_id: str, artifact: Dict[str, Any]) -> None:
    items = load_items(session_id)
    key = _content_key(artifact)
    for i, existing in enumerate(items):
        if existing.get("id") == artifact.get("id") or _content_key(existing) == key:
            items[i] = artifact
            break
    else:
        items.insert(0, artifact)
    _save_items(session_id, items)


def store_check(session_id: str, item_id: str, index: int, done: bool) -> None:
    """The user ticked (or unticked) a checklist line in the app."""
    items = load_items(session_id)
    for art in items:
        checks = art.get("checklist") if art.get("id") == item_id else None
        if isinstance(checks, list) and 0 <= index < len(checks) and isinstance(checks[index], dict):
            checks[index]["done"] = bool(done)
            _save_items(session_id, items)
            return


def store_update(session_id: str, item_id: str, op: str, args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The user changed an item on the board (timer controls, a card moved between columns, a form sent).
    Returns the updated item, or None when nothing changed."""
    import time as _time

    items = load_items(session_id)
    art = next((a for a in items if a.get("id") == item_id), None)
    if art is None:
        return None
    if op == "timer" and isinstance(art.get("timer"), dict):
        t = art["timer"]
        now_ms = int(_time.time() * 1000)
        action = args.get("action")
        if action == "pause" and "paused_left" not in t:
            t["paused_left"] = max(0, int(t["ends_at"]) - now_ms)
        elif action == "resume" and "paused_left" in t:
            t["ends_at"] = now_ms + int(t.pop("paused_left"))
        elif action == "add":
            extra = int(max(1, min(120, float(args.get("minutes") or 5))) * 60_000)
            if "paused_left" in t:
                t["paused_left"] = int(t["paused_left"]) + extra
            else:
                t["ends_at"] = max(int(t["ends_at"]), now_ms) + extra
            t["seconds"] = int(t.get("seconds", 0)) + extra // 1000
        elif action == "stop":
            t.pop("paused_left", None)
            t["ends_at"] = now_ms
            t["stopped"] = True
        else:
            return None
    elif op == "board_move" and isinstance(art.get("board"), list):
        cols = art["board"]
        src, dst = args.get("from"), args.get("to")
        label = str(args.get("label") or "")
        if not (isinstance(src, int) and isinstance(dst, int) and 0 <= src < len(cols) and 0 <= dst < len(cols)):
            return None
        cards = cols[src].get("cards") or []
        card = next((c for c in cards if c.get("label") == label), None)
        if card is None:
            return None
        cards.remove(card)
        dest = cols[dst].setdefault("cards", [])
        pos = args.get("index")
        dest.insert(pos if isinstance(pos, int) and 0 <= pos <= len(dest) else len(dest), card)
    elif op == "form_sent" and isinstance(art.get("form"), dict):
        values = args.get("values") if isinstance(args.get("values"), dict) else {}
        art["form"]["sent"] = {_text(k, 60): _text(v, 300) for k, v in list(values.items())[:10]}
    else:
        return None
    _save_items(session_id, items)
    return art


def store_remove(session_id: str, item_id: str) -> None:
    _save_items(session_id, [a for a in load_items(session_id) if a.get("id") != item_id])


def store_clear(session_id: str) -> None:
    _save_items(session_id, [])


# --- analysis turns ---------------------------------------------------------------------------------
# Small local models "analyse" a data file by eyeballing it: wrong totals, a table dumped into the chat.
# On turns that look like analysis, a short per-turn note sends the numbers through code and onto the board.
_ANALYSE = re.compile(
    r"\b(analy[sz]e|analysis|break ?down|insights?|trends?|statistics|stats on|where (?:does|did|do) my|"
    r"summari[sz]e (?:the|my|this) (?:data|numbers|spending|sales|file|sheet)|crunch|visuali[sz]e|dashboard)\b"
    r"|\.(?:csv|tsv|xlsx?|json)\b",
    re.IGNORECASE,
)
ANALYSIS_NOTE = (
    "[VYRSE: this is an analysis. A data file (CSV, Excel, JSON): call vyrse_analyse with its path; it computes "
    "everything and builds the dashboard. Otherwise never estimate numbers by eye; show what you find with "
    "vyrse_workspace (a chart of the main measure with the top one highlighted, stats with the headline numbers). "
    "The chat reply is only the headline finding in a sentence or two, with the tool's exact numbers.]"
)


# Everyday asks where a picture beats a paragraph. The model often answered these in text, so a matching
# turn gets a one-line nudge toward the right card (it stays the model's call: "if it fits").
_HINTS = [
    (re.compile(r"\b(storage|disk space|(?:eating|using|filling) (?:up )?my (?:space|storage|disk|drive)|space on my (?:pc|drive|disk|c))\b"
                r"|\b(?:folder|drive|directory|appdata)\b.{0,40}\b(?:so big|big|huge|taking (?:up )?(?:so much )?space|full)\b", re.I),
     "For what's using disk space: vyrse_system action=storage show=true (it measures the folders and draws the chart; "
     "path = a folder to look inside). Never search files for this."),
    (re.compile(r"\b(?:pick|choose|decide|select)\b.{0,40}\b(?:random(?:ly)?|for me)\b|\bcan'?t decide\b|\bflip a coin\b|\broll (?:a |the )?dic?e\b|\bspin the wheel\b|\brandom(?:ly)? pick", re.I),
     "For a random pick: vyrse_workspace kind=picker with the options as items (a wheel that spins and picks on screen; "
     "for a coin use Heads/Tails, for a die 1-6). Don't pick yourself or run code."),
    (re.compile(r"\b(?:vs\.?|versus|which (?:one |is )?(?:better|best)|should i (?:buy|get|pick|choose|go for)|compare|comparison|pros and cons)\b", re.I),
     "For a comparison: show it in the workspace, a table (one row per option, first cell = the option, highlight your "
     "pick) and/or cards with pros, cons and a verdict; say the verdict in a sentence."),
    (re.compile(r"\b(?:i keep forgetting how (?:much|to)|calculator|converter|convert\b.{0,30}\bto\b|split (?:the )?bill|tip (?:to leave|calculator))", re.I),
     "If a small interactive tool would help, build it: vyrse_workspace kind=app (one working HTML page)."),
    (re.compile(r"\b(?:need to|want to|help me|time to|let'?s) (?:focus|concentrate|study)\b|\bpomodoro\b|\bfocus (?:mode|session|timer)\b", re.I),
     "A focus session: start a vyrse_workspace timer (25 minutes unless they say)."),
    (re.compile(r"\b(?:how (?:long|many days)|days?) (?:until|till|to go)\b|\bcount ?down to\b", re.I),
     "A countdown to a date: vyrse_workspace kind=timer with until (the date)."),
    (re.compile(r"\b(?:i want to|i'?m going to|my goals?|aim(?:ing)? to|target is|plan to)\b.{0,80}\b(?:today|tonight|this week)\b", re.I),
     "Goals for later aren't logs: show them as vyrse_workspace rings, value = done so far (usually 0) and max = the "
     "target (3 chapters: value 0, max 3); log things once done."),
    (re.compile(r"\b(?:plan|schedule|timetable|prepare for|revision plan|study plan)\b|\bexams?\b.{0,40}\b(?:mon|tue|wed|thu|fri|sat|sun)", re.I),
     "A plan: show it in the workspace (a timeline for dates, a board or checklist for the tasks)."),
    (re.compile(r"\b(?:mind ?map|map (?:it )?out|explain .{0,40} (?:visually|as a map)|break .{0,30} into (?:parts|topics))\b", re.I),
     "To map a topic: vyrse_workspace kind=mindmap with title = the topic and outline = an indented list "
     "('- Branch' lines, each with '  - sub-point' lines under it)."),
    (re.compile(r"\bflash ?cards?\b|\brevision cards?\b", re.I),
     "Flashcards: vyrse_workspace kind=flashcards with cards = one per line 'question :: answer'."),
    (re.compile(r"\b(?:quiz|test) me\b|\bquiz (?:on|about)\b|\bgive me (?:a )?quiz\b", re.I),
     "A quiz: vyrse_quiz action=start with text = one question per line 'question :: correct answer :: topic :: "
     "option | option | option | option' (one option is the answer; the user taps them on screen)."),
    (re.compile(r"\b(?:cpu|ram|memory|gpu|vram|disk|battery)\b.{0,40}\b(?:ring|donut|doughnut|chart|graph|visual)", re.I),
     "Usage as a share of a limit (CPU, RAM, GPU, disk, battery): vyrse_workspace rings or gauges, not a donut."),
]


_NUMBERS_NOTE = ("Several numbers: show them in the workspace, picking the picture that fits (not a table): parts "
                 "of a whole like spending = donut; over time = line; comparing amounts = bar; % of a goal or limit = rings.")


_DOING = [
    (re.compile(r"^(?!.*(?:\d{2}|[$₹€£]|\d\s*k\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\bfrom\b.{1,30}\bto\b))(?=.{0,70}$).*\b(?:plan|organi[sz]e|arrange|help me plan)\b.{0,30}\b(?:trip|holiday|vacation|getaway|party|birthday|wedding|event|week|weekend|diet|workout|meal plan|budget|move|road ?trip)\b", re.I),
     "They haven't said the details yet: ask for them on screen with ONE vyrse_workspace kind=form card (3-5 fields "
     "that matter for this, e.g. where / when / budget as select Low/Mid/High / what they're into), submit = 'Plan it', "
     "and a one-line reply. Don't invent a plan before they answer."),
    (re.compile(r"\bwhere(?:'s| is| are| do i find| can i find)\b.{0,50}\b(?:button|menu|setting|settings|option|tab|icon|toggle|link|field|bar)\b|\bshow me where\b|\bpoint (?:to|at|me)\b|\bwalk me through\b|\bhow do i (?:turn on|turn off|enable|disable|change|find|export|save|open)\b.{0,40}\b(?:in|on) (?:this|here|it)\b", re.I),
     "Point at it on their screen: vyrse_point action=show (target = the visible label, caption = what to do), or "
     "action=steps for a walkthrough ('label :: what to do' lines). Don't click it unless they ask you to do it."),
    (re.compile(r"\b(?:live )?(?:captions?|subtitles?)\b|\btranslate (?:this|the) (?:video|call|stream|audio|show|movie|clip)\b|\bwhat (?:are|is) (?:they|he|she) saying\b", re.I),
     "Live captions of what's playing on the PC: vyrse_captions action=start (to = the language they want; default en) or stop."),
    (re.compile(r"\bbreak (?:this|it|these|them) down\b|\bwhat'?s in (?:this|these) (?:file|pdf|doc|document)s?\b|\bgo through (?:this|these) (?:file|pdf|doc)", re.I),
     "Break it down: vyrse_digest with path = the attached file (one call per file), then build the cards it suggests."),
    (re.compile(r"\bsnapped this with my phone\b", re.I),
     "A photo from their phone: read it with vyrse_screen image=<that path>. Work out what it is (a receipt, homework, a "
     "whiteboard, a menu or sign in another language, a product, an error on a screen, a business card…) and build the "
     "right cards with buttons for what they'd want next. Reply in two sentences."),
    (re.compile(r"\brecord (?:this|the|my|a)\b.{0,20}\b(?:lecture|class|lesson|meeting|call|talk|seminar)\b|\bstop recording\b", re.I),
     "Recording: vyrse_notes action=record (title = what it is) or action=stop."),
    (re.compile(r"\b(?:notes|flash ?cards|summary|summari[sz]e|quiz me)\b.{0,40}\b(?:lecture|recording|class|meeting|audio|video|\.mp3|\.m4a|\.wav|\.mp4)\b", re.I),
     "Notes from a recording: vyrse_notes action=transcribe (path, or 'latest'), then the summary, flashcards and a quiz offer."),
    (re.compile(r"\b(?:how was my day|recap (?:my|the) day|(?:nightly|daily|end of (?:the )?day) recap|sum(?:marise|marize) my day)\b", re.I),
     "The nightly recap: vyrse_system action=recap (it shows the card)."),
    (re.compile(r"\b(?:check[- ]?up on|health check|diagnose|why is my (?:pc|computer|laptop) (?:so )?slow|speed up my (?:pc|computer)|pc doctor)\b", re.I),
     "A PC check-up: vyrse_system action=doctor (it shows the findings); only fix things after a yes."),
    (re.compile(r"\b(?:make|create|add|set up|save)\b.{0,20}\broutine\b", re.I),
     "A routine: vyrse_routine action=create with name = the phrase that runs it and steps = what to do in order (name the tool for each)."),
    (re.compile(r"\b(?:make|create|design|invent)\b.{0,20}\b(?:talk(?:ing)? style|personality|persona)\b|\btalk (?:to me )?like (?:my|a|an)\b", re.I),
     "A talk style of their own: vyrse_style action=create (you write the prompt from what they described; ask one question first if it's vague)."),
    (re.compile(r"\b(?:help me|i need to|time to|let'?s) (?:focus|concentrate|lock in|study)\b|\bfocus (?:mode|session|guardian)\b|\bkeep me (?:focused|off (?:youtube|my phone|games))", re.I),
     "Focus: a workspace timer plus vyrse_focus action=start (same minutes) so VYRSE nudges them if they drift."),
    (re.compile(r"\b(?:set (?:yourself|you|me) up|personal setup|(?:get|getting) to know (?:me|you)|redo (?:my )?(?:profile|setup)|personali[sz]e (?:yourself|you|vyrse))\b", re.I),
     "The personal setup: load the vyrse-setup skill (skill_view) and follow it, starting with vyrse_profile action=start."),
    (re.compile(r"\b(?:set|make|add)\b.{0,12}\balarm\b|\bwake me(?: up)?\b.{0,20}\b(?:at|by|in)\b|\balarm (?:for|at)\b", re.I),
     "An alarm: vyrse_reminders action=create alarm=true schedule='<clock time, e.g. 8:30>' (it rings in VYRSE and shows a countdown)."),
    (re.compile(r"\b(?:clean(?: up)?|sort|organi[sz]e|tidy(?: up)?|declutter)\b.{0,20}\b(?:downloads?|desktop|documents|pictures|videos|folder)\b", re.I),
     "Sorting a folder: vyrse_files action=organize in=<downloads/desktop/… or a path> (VYRSE asks the user first, never "
     "deletes, shows the sorted folders). Don't move files yourself."),
    (re.compile(r"\b(?:tidy|clean(?: up)?|arrange|organi[sz]e|sort|snap|split)\b.{0,25}\bwindows\b|\bside by side\b|\bsplit ?screen\b", re.I),
     "Tidying windows: vyrse_desktop action=windows, then one action=arrange per window (position left/right/top-left/…, or "
     "minimize for the rest)."),
    (re.compile(r"\bhow long\b.{0,30}\b(?:gaming|playing|been on|on my (?:pc|computer)|screen)\b|\bscreen ?time\b|\btime (?:did i |have i )?(?:spend|spent)\b", re.I),
     "Screen and gaming time: vyrse_system action=usage (period=week for the week); it's measured, never guess."),
    (re.compile(r"\b(?:ping|alert|tell|notify|warn|text)\b.{0,10}\b(?:me|my phone)\b.{0,50}\b(?:if|when|once)\b.{0,60}\b(?:over|above|under|below|hits?|reach(?:es)?|goes|drops?)\b", re.I),
     "A threshold alert: vyrse_system action=watch metric=<gpu_temp/gpu/cpu/memory> alert_above (or alert_below) = the number, "
     "notify_phone=true if they said phone, minutes=120; then reply in a few words."),
    (re.compile(r"\b(?:i'?m |i am )?(?:heading|going) out\b|\bi'?m (?:off|leaving)\b|\bleaving (?:now|the house)\b", re.I),
     "Heading out: save their open work (vyrse_desktop windows; for editors/documents with unsaved changes, a '*' or '●' "
     "in the title, action=keys ctrl+s), set any reminder they want, then vyrse_controls lock. Say it in one line."),
]
_LATE = re.compile(r"\b(?:one more|episode|another (?:round|game|match)|still up|can'?t sleep|stay(?:ing)? up|all ?nighter|not tired|keep (?:playing|watching))\b", re.I)


def hints(text: str) -> List[str]:
    import time as _time

    found = [note for pattern, note in _DOING if pattern.search(text)]
    try:
        from . import routines

        found = routines.hint(text) + found
    except Exception:
        pass
    hour = _time.localtime().tm_hour
    if 0 <= hour < 5 and _LATE.search(text):
        found.insert(0, f"It's {_time.strftime('%H:%M')}, the middle of the night: in their talk style, tell them to sleep "
                        "(say the real time, and anything they have tomorrow if you know it). Then set an alarm for the morning "
                        "(vyrse_reminders action=create alarm=true) and, if they go along, vyrse_controls screen_off.")
    found += [note for pattern, note in _HINTS if pattern.search(text)]
    # Three or more figures (not dates or times) usually want a chart: "40 on food, 25 on uber and 60 on a game".
    plain = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)  # 2,450 is one number
    if len(re.findall(r"(?<![\d:/.-])\d+(?:\.\d+)?(?![\d:/-])", plain)) >= 3:
        found.append(_NUMBERS_NOTE)
    if any(n.startswith("They haven't said the details yet") for n in found):
        found = [n for n in found if not n.startswith("A plan:")]  # ask first; the plan comes after
    return found[:2]


def pre_llm_call(**kwargs: Any) -> Optional[Dict[str, str]]:
    if kwargs.get("platform") != "vyrse":
        return None
    text = str(kwargs.get("user_message") or "")[:2000]
    if _ANALYSE.search(text):
        return {"context": ANALYSIS_NOTE}
    found = hints(text)
    return {"context": "[VYRSE: " + " ".join(found) + "]"} if found else None
