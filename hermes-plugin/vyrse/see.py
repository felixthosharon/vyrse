"""Look before acting: which control on screen does the user mean?

Matching words alone fails on icon buttons (a gear, a magnifier, a share arrow) and on the same word appearing in
several places. Here the candidates (from UI Automation, or a web page's elements) are numbered on a screenshot and
the local vision model picks the one that fits the request, looking at the icons as well as the labels. It may
answer "none", and a number that wasn't drawn is rejected, so nothing gets invented.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

MAX_MARKS = 60
_COLORS = ("#e5007a", "#0a7cff", "#00a86b", "#ff7a00", "#7b2ff7", "#d10000")
_CLICKABLE = {"Button", "MenuItem", "TabItem", "Hyperlink", "ListItem", "CheckBox", "RadioButton", "ComboBox", "Edit",
              "TreeItem", "SplitButton", "Slider", "DataItem", "link", "button", "input", "select", "textarea", "tab",
              "menuitem", "checkbox", "radio", "option", "switch", "textbox", "searchbox", "combobox"}


def _words(text: str) -> List[str]:
    return [w for w in re.split(r"[^\w]+", str(text or "").lower()) if w]


def label_of(item: Dict[str, Any]) -> str:
    """What a person would call it: its name, else its tooltip, else its id."""
    for key in ("name", "help", "id"):
        value = str(item.get(key) or "").strip()
        if value:
            return value[:80]
    return ""


# Everyday words for controls that apps name differently (help pages say "Profile"; Chrome's button is named
# after the account and its class is AvatarToolbarButton).
_SYNONYMS = {
    "profile": ["avatar", "account", "sign", "person", "user"], "account": ["avatar", "profile", "sign"],
    "dots": ["menu", "more", "options", "app"], "menu": ["more", "options", "dots", "app"], "more": ["menu", "options", "overflow"],
    "puzzle": ["extensions", "extension"], "extensions": ["puzzle", "extension"], "plus": ["new", "add"],
    "star": ["bookmark", "favorite", "favourite"], "bookmark": ["star"], "gear": ["settings", "preferences"],
    "settings": ["gear", "preferences", "options"], "magnifier": ["search", "find"], "search": ["find", "magnifier"],
    "bin": ["delete", "trash", "remove"], "trash": ["delete", "bin", "remove"], "share": ["send", "export"],
}


def _class_words(item: Dict[str, Any]) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", str(item.get("cls") or ""))


_FILLER_WORDS = {"the", "a", "an", "at", "to", "on", "in", "of", "and", "or", "it", "this", "that", "top", "bottom",
                 "left", "right", "corner", "click", "select", "choose", "tap", "press", "open", "go", "button", "icon",
                 "then", "your", "you", "will", "see", "find", "use", "with", "for", "from", "menu"}


def _wanted(query: str) -> set:
    want = set(_words(query))
    for w in list(want):
        want.update(_SYNONYMS.get(w, []))
    return want


def shortlist(items: Sequence[Dict[str, Any]], query: str, limit: int = MAX_MARKS) -> List[Dict[str, Any]]:
    """The controls worth numbering: ones whose words overlap the request (synonyms and class names count) first,
    then unlabeled or icon-like clickable ones (what text matching can't see), then the rest, top to bottom."""
    want = _wanted(query)

    def rank(item: Dict[str, Any]) -> tuple:
        text = " ".join(str(item.get(k) or "") for k in ("name", "help", "id", "hint")) + " " + _class_words(item)
        overlap = len(want & set(_words(text)))
        clickable = str(item.get("type") or "") in _CLICKABLE
        unlabeled = not str(item.get("name") or "").strip() or bool(item.get("icon"))
        r = item.get("rect") or {}
        return (-overlap, not (clickable and unlabeled), not clickable, int(r.get("y", 0)) // 24, int(r.get("x", 0)))

    seen = set()
    out = []
    for item in sorted(items, key=rank):
        r = item.get("rect") or {}
        key = (int(r.get("x", 0)) // 6, int(r.get("y", 0)) // 6, int(r.get("width", 0)) // 6)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= limit:
            break
    return out


def draw_marks(png: bytes, marks: Sequence[Dict[str, Any]], origin: Sequence[float] = (0, 0), scale: float = 1.0,
               max_side: int = 1400) -> bytes:
    """Number each mark on the screenshot (rects are in the same pixels as the image, offset by `origin`)."""
    from PIL import Image, ImageDraw, ImageFont

    img = Image.open(io.BytesIO(png)).convert("RGB")
    shrink = min(1.0, max_side / max(img.size))
    if shrink < 1.0:
        img = img.resize((int(img.width * shrink), int(img.height * shrink)), Image.LANCZOS)
    k = scale * shrink
    d = ImageDraw.Draw(img)
    size = max(13, int(img.width / 75))
    try:
        font = ImageFont.truetype("arialbd.ttf", size)
    except OSError:
        font = ImageFont.load_default()
    for i, m in enumerate(marks, 1):
        r = m["rect"]
        x1, y1 = (r["x"] - origin[0]) * k, (r["y"] - origin[1]) * k
        x2, y2 = x1 + r["width"] * k, y1 + r["height"] * k
        color = _COLORS[i % len(_COLORS)]
        d.rectangle([x1, y1, x2, y2], outline=color, width=2)
        tag = str(i)
        tw = d.textlength(tag, font=font)
        tx, ty = max(0, x1 - 1), max(0, y1 - size - 3) if y1 > size + 3 else y2 + 1
        d.rectangle([tx, ty, tx + tw + 6, ty + size + 3], fill=color)
        d.text((tx + 3, ty + 1), tag, fill="white", font=font)
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


# Answer shapes the model is held to (llama.cpp turns a JSON schema into a grammar): a small model otherwise
# starts "Looking at the image, I need to…", runs out of tokens and gives no answer at all.
PICK = {"type": "object", "properties": {"mark": {"type": ["integer", "null"]}, "why": {"type": "string", "maxLength": 60}},
        "required": ["mark", "why"]}
YES_NO = {"type": "object", "properties": {"answer": {"type": "string", "enum": ["yes", "no"]}}, "required": ["answer"]}
BOX = {"type": "object", "properties": {
    "bbox_2d": {"anyOf": [{"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4}, {"type": "null"}]},
    "label": {"type": "string", "maxLength": 40}}, "required": ["bbox_2d", "label"]}


def ask_vision(png: bytes, prompt: str, max_tokens: int = 200, timeout: float = 90, schema: Optional[Dict[str, Any]] = None) -> str:
    """One question about one image, to the local vision model (the main model's image encoder)."""
    from agent.auxiliary_client import call_llm, extract_content_or_reasoning

    url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    extra: Dict[str, Any] = {"chat_template_kwargs": {"enable_thinking": False}}
    if schema:
        extra["response_format"] = {"type": "json_schema", "json_schema": {"name": "answer", "schema": schema}}
    resp = call_llm(task="vision", messages=[{"role": "user", "content": [
        {"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": url}}]}],
        max_tokens=max_tokens, temperature=0, timeout=timeout, extra_body=extra)
    return str(extract_content_or_reasoning(resp) or "").strip()


def parse_choice(answer: str, count: int) -> Optional[int]:
    """The mark number the model chose, or None for 'none' / anything that isn't one of the drawn numbers."""
    text = str(answer or "")
    try:
        start, end = text.index("{"), text.rindex("}") + 1
        value = json.loads(text[start:end]).get("mark")
        n = int(value) if value not in (None, "", "none") else 0
    except (ValueError, TypeError, AttributeError):
        # no JSON: only a bare number counts ("4", "Mark 4."); prose with numbers in it is not a choice
        m = re.fullmatch(r"\s*(?:mark|box|number)?\s*#?(\d+)\s*\.?\s*", text, re.I)
        n = int(m.group(1)) if m else 0
    return n if 1 <= n <= count else None


def _describe(i: int, item: Dict[str, Any]) -> str:
    kind = str(item.get("type") or "").lower() or "item"
    label = label_of(item)
    hint = str(item.get("hint") or "").strip() or _class_words(item).strip()
    text = f'{i}: {kind} "{label}"' if label else f"{i}: {kind}, no label (icon)"
    return text + (f" [{hint[:60]}]" if hint else "")


def choose(png: bytes, items: Sequence[Dict[str, Any]], request: str, *, origin: Sequence[float] = (0, 0),
           scale: float = 1.0, where: str = "") -> Dict[str, Any]:
    """Pick the control the user means. -> {ok, item, mark} or {ok: False, error, labels}."""
    marks = shortlist(items, request)
    if not marks:
        return {"ok": False, "error": "No controls found in that window.", "labels": []}
    sure = _by_words(marks, request, ignore=where)
    if sure is not None:
        return {"ok": True, "item": sure, "mark": marks.index(sure) + 1, "why": "name matches"}
    picture = draw_marks(png, marks, origin=origin, scale=scale)
    _keep(picture)
    listing = "\n".join(_describe(i, m) for i, m in enumerate(marks, 1))
    prompt = (
        f"This is a screenshot of {where or 'an app window'}. Coloured numbered boxes mark its controls; the list "
        f"below gives each number's type and accessible label (many icon buttons have no label: judge those by the "
        f"icon you see in the box).\n\n{listing}\n\nThe user wants: \"{request}\"\n\n"
        "Which ONE numbered box is that control? Use the icon's meaning (gear = settings, magnifier = search, "
        "trash can = delete, arrow out of a box = share, three dots = more options, pencil = edit, plus = new, "
        "house = home, bell = notifications, X = close...) as well as the text. If none of the boxes is it, "
        "say none. Never guess a number you are not sure of.\n"
        'Reply with JSON only: {"mark": <number or null>, "why": "<5 words>"}'
    )
    try:
        answer = ask_vision(picture, prompt, max_tokens=80, schema=PICK)
    except Exception as exc:  # the model is down or busy: say so rather than click something at random
        logger.warning("vyrse: vision grounding failed: %s", exc)
        return {"ok": False, "error": f"Couldn't look at the screen: {exc}", "labels": [label_of(m) for m in marks if label_of(m)][:30]}
    n = parse_choice(answer, len(marks))
    logger.info("vyrse: grounding %r -> %r (%s marks)", request, answer[:120], len(marks))
    if n is None:
        return {"ok": False, "error": f"I looked, and nothing on screen matches '{request}'.",
                "labels": [label_of(m) for m in marks if label_of(m)][:30]}
    item = marks[n - 1]
    if not _wanted(request) & set(_words(" ".join(str(item.get(k) or "") for k in ("name", "help", "id")) + " " + _class_words(item))):
        # chosen by looks alone: zoom in on it and make sure, so a near miss doesn't get clicked
        try:
            if not confirm(png, item, request, origin=origin, scale=scale):
                logger.info("vyrse: grounding %r -> mark %s rejected on a closer look", request, n)
                return {"ok": False, "error": f"I looked, and nothing on screen clearly matches '{request}'.",
                        "labels": [label_of(m) for m in marks if label_of(m)][:30]}
        except Exception as exc:
            logger.warning("vyrse: grounding check failed: %s", exc)
    return {"ok": True, "item": item, "mark": n, "why": _why(answer)}


def _by_words(marks: Sequence[Dict[str, Any]], request: str, ignore: str = "") -> Optional[Dict[str, Any]]:
    """One clickable control whose name/class/tooltip shares clearly more of the request's words (synonyms
    counted) than any other: no need to ask the vision model. Ties and weak matches go to the model."""
    # the app's own name says nothing about which control ("the paint bucket" in Paint is the Fill tool)
    want = _wanted(request) - _FILLER_WORDS - set(_words(ignore))
    if not want:
        return None
    scored = []
    for m in marks:
        if str(m.get("type") or "") not in _CLICKABLE or m.get("disabled"):
            continue
        words = set(_words(" ".join(str(m.get(k) or "") for k in ("name", "help", "id")) + " " + _class_words(m)))
        scored.append((len(want & words), m))
    scored.sort(key=lambda p: -p[0])
    if not scored or scored[0][0] < 1 or (len(scored) > 1 and scored[1][0] >= scored[0][0]):
        return None
    return scored[0][1]


def confirm(png: bytes, item: Dict[str, Any], request: str, *, origin: Sequence[float] = (0, 0),
            scale: float = 1.0) -> bool:
    """A close-up of one control: is it really what the user asked for? (yes/no)"""
    from PIL import Image

    img = Image.open(io.BytesIO(png)).convert("RGB")
    r = item["rect"]
    pad = 24
    x1 = max(0, int((r["x"] - origin[0]) * scale) - pad)
    y1 = max(0, int((r["y"] - origin[1]) * scale) - pad)
    x2 = min(img.width, int((r["x"] - origin[0] + r["width"]) * scale) + pad)
    y2 = min(img.height, int((r["y"] - origin[1] + r["height"]) * scale) + pad)
    crop = img.crop((x1, y1, x2, y2))
    k = max(1.0, 160 / max(1, min(crop.size)))
    crop = crop.resize((int(crop.width * k), int(crop.height * k)), Image.LANCZOS)
    out = io.BytesIO()
    crop.save(out, "PNG")
    label = label_of(item)
    labelled = f' (its accessible label is "{label}")' if label else ""
    answer = ask_vision(out.getvalue(), (
        f"A close-up of one control in an app{labelled}. "
        f'The user asked for: "{request}". Look at its icon and text. Is this control what they mean? '
        'Answer {"answer": "yes"} or {"answer": "no"}.'), max_tokens=20, schema=YES_NO)
    return '"yes"' in answer.lower() or answer.strip().lower().startswith("yes")


def _keep(picture: bytes) -> None:
    """The last marked-up screenshot stays on disk (vyrse/screen/marked.png) for checking what the model saw."""
    try:
        from hermes_constants import get_hermes_home
        from pathlib import Path

        (Path(get_hermes_home()) / "vyrse" / "screen" / "marked.png").write_bytes(picture)
    except Exception:
        pass


def _why(answer: str) -> str:
    try:
        return str(json.loads(answer[answer.index("{"): answer.rindex("}") + 1]).get("why") or "")[:80]
    except (ValueError, AttributeError):
        return ""


# ------------------------------------------------------------------ by pixels alone (no element list to number)
def _boxes(answer: str) -> List[List[float]]:
    out = []
    for m in re.finditer(r"\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]", answer or ""):
        out.append([float(v) for v in m.groups()])
    return out


def locate_pixels(png: bytes, request: str, where: str = "", max_side: int = 1280) -> Optional[Dict[str, int]]:
    """Where is it, straight from the screenshot? For pages and apps that expose no controls (canvas apps, editors
    inside foreign frames, games). The model gives a box (Qwen's 0-1000 grid); a close-up check must agree, else
    None. Returns a rect in the screenshot's pixels."""
    from PIL import Image

    img = Image.open(io.BytesIO(png)).convert("RGB")
    W, H = img.size
    k = min(1.0, max_side / max(W, H))
    small = img.resize((int(W * k), int(H * k)), Image.LANCZOS) if k < 1 else img
    buf = io.BytesIO()
    small.save(buf, "PNG")
    prompt = (
        f"This is a screenshot of {where or 'an app'}. Find the control the user means: \"{request}\" (a button, "
        "menu, tab, link, field or icon; judge icons by what they show). If it isn't visible, answer null.\n"
        'Reply with JSON only: {"bbox_2d": [x1, y1, x2, y2], "label": "<its visible text or icon>"} '
        "with coordinates on a 0-1000 grid over the image, or {\"bbox_2d\": null}."
    )
    answer = ask_vision(buf.getvalue(), prompt, max_tokens=80, schema=BOX)
    logger.info("vyrse: pixel grounding %r -> %r", request, answer[:160])
    boxes = _boxes(answer)
    if not boxes:
        return None
    x1, y1, x2, y2 = boxes[0]
    if max(x1, y1, x2, y2) > 1000.5:  # absolute pixels of the image it was shown
        sx, sy = W / small.width, H / small.height
    else:
        sx, sy = W / 1000.0, H / 1000.0
    rect = {"x": int(min(x1, x2) * sx), "y": int(min(y1, y2) * sy),
            "width": max(6, int(abs(x2 - x1) * sx)), "height": max(6, int(abs(y2 - y1) * sy))}
    if rect["width"] * rect["height"] > 0.25 * W * H:
        return None  # a box around half the screen isn't a control
    try:
        if not confirm(png, {"rect": rect}, request):
            logger.info("vyrse: pixel grounding %r rejected on a closer look", request)
            return None
    except Exception as exc:
        logger.warning("vyrse: pixel grounding check failed: %s", exc)
    return rect


# ------------------------------------------------------------------ visible text, read off the screenshot (Windows OCR)
def ocr_lines(png: bytes) -> List[Dict[str, Any]]:
    """Every line of text in the image, with each word's box (image pixels). Empty when OCR isn't available."""
    import subprocess
    import tempfile
    from pathlib import Path

    from hermes_cli._subprocess_compat import windows_hide_flags

    script = Path(__file__).resolve().parent / "screen" / "ocr.ps1"
    fd, path = tempfile.mkstemp(suffix=".png", prefix="vyrse-ocr-")
    try:
        with open(fd, "wb") as f:
            f.write(png)
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Path", path, "-Boxes"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            stdin=subprocess.DEVNULL, creationflags=windows_hide_flags())
        out = (result.stdout or "").strip()
        lines = json.loads(out[out.index("["):]) if "[" in out else []
        return [l for l in lines if isinstance(l, dict) and l.get("words")]
    except Exception as exc:
        logger.info("vyrse: OCR unavailable: %s", exc)
        return []
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _span_rect(words: Sequence[Dict[str, Any]]) -> Dict[str, int]:
    x1 = min(w["x"] for w in words)
    y1 = min(w["y"] for w in words)
    x2 = max(w["x"] + w["width"] for w in words)
    y2 = max(w["y"] + w["height"] for w in words)
    return {"x": x1 - 4, "y": y1 - 3, "width": x2 - x1 + 8, "height": y2 - y1 + 6}


def text_hits(lines: Sequence[Dict[str, Any]], query: str) -> List[Dict[str, Any]]:
    """Places where the exact words of the query appear on screen (case and punctuation ignored)."""
    want = _words(query)
    if not want:
        return []
    hits = []
    for line in lines:
        words = line["words"]
        norm = [" ".join(_words(w.get("text"))) for w in words]
        for i in range(len(words)):
            j, k = i, 0
            got: List[str] = []
            while j < len(words) and k < len(want):
                piece = norm[j].split()
                if not piece:
                    j += 1
                    continue
                if piece != want[k:k + len(piece)]:
                    break
                got.append(norm[j])
                k += len(piece)
                j += 1
            if k == len(want) and got:
                hits.append({"text": " ".join(w["text"] for w in words[i:j]), "rect": _span_rect(words[i:j]),
                             "line": line.get("text", "")})
    return hits


def ocr_items(lines: Sequence[Dict[str, Any]], limit: int = 80) -> List[Dict[str, Any]]:
    """Text lines as candidates for numbering (for UIs that expose no controls)."""
    return [{"type": "Text", "name": str(l.get("text") or "")[:80], "rect": _span_rect(l["words"])} for l in lines[:limit]]
