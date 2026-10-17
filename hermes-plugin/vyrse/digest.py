"""`vyrse_digest`: drop anything on VYRSE and get it broken down on the board.

Reads the file on this PC (PDF, Word, PowerPoint, text and code, web pages, images by OCR, audio/video by local
transcription; spreadsheets go to vyrse_analyse) and tells the model which cards fit THIS kind of thing: a report
gets the gist, a map and its numbers; a contract its terms and risks; a receipt a table and the total; code its
structure and issues; a recording its chapters. A "reading…" card shows at once, so the board reacts the moment
the file lands.
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any, Dict, Tuple

MAX_TEXT = 24_000
TEXT_EXT = {".txt", ".md", ".log", ".rtf", ".srt", ".vtt", ".ini", ".cfg", ".yaml", ".yml", ".toml", ".xml"}
CODE_EXT = {".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".rb", ".php",
            ".swift", ".kt", ".sql", ".sh", ".ps1", ".lua", ".dart", ".vue", ".css", ".scss"}
DATA_EXT = {".csv", ".tsv", ".xlsx", ".xls", ".json", ".parquet"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
MEDIA_EXT = {".mp3", ".wav", ".m4a", ".ogg", ".opus", ".flac", ".aac", ".webm", ".mp4", ".mkv", ".mov", ".avi", ".wma"}

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_digest",
    "description": (
        "Break down a file the user dropped or named ('break this down', 'what's in this', 'go through this "
        "file'): PDF, Word, PowerPoint, text, code, web page, image, audio or video. path = the file. It reads it on "
        "this PC and says which workspace cards fit it; then build them (several cards, one call each) and reply "
        "with the headline in two sentences."
    ),
    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
}


def _pylib() -> None:
    try:
        from hermes_constants import get_hermes_home

        lib = str(Path(get_hermes_home()) / "vyrse" / "pylib")
        if lib not in sys.path:
            sys.path.append(lib)
    except Exception:
        pass


def _xml_text(xml: str, para: str) -> str:
    xml = re.sub(rf"</{para}>", "\n", xml)
    xml = re.sub(r"<[^>]+>", "", xml)
    import html

    return re.sub(r"\n{3,}", "\n\n", html.unescape(xml)).strip()


def _pdf(path: Path) -> Tuple[str, Dict[str, Any]]:
    _pylib()
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    pages = len(reader.pages)
    parts, size = [], 0
    for i, page in enumerate(reader.pages[:80]):
        t = (page.extract_text() or "").strip()
        if t:
            parts.append(f"[page {i + 1}]\n{t}")
            size += len(t)
        if size > MAX_TEXT:
            break
    return "\n\n".join(parts), {"pages": pages, "scanned": size < 40 * max(1, min(pages, 5))}


def _docx(path: Path) -> str:
    with zipfile.ZipFile(path) as z:
        return _xml_text(z.read("word/document.xml").decode("utf-8", "replace"), "w:p")


def _pptx(path: Path) -> Tuple[str, Dict[str, Any]]:
    with zipfile.ZipFile(path) as z:
        slides = sorted((n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)),
                        key=lambda n: int(re.findall(r"\d+", n)[-1]))
        parts = [f"[slide {i + 1}]\n{_xml_text(z.read(n).decode('utf-8', 'replace'), 'a:p')}" for i, n in enumerate(slides)]
    return "\n\n".join(parts), {"slides": len(slides)}


def _html(path: Path) -> str:
    raw = path.read_text(encoding="utf-8", errors="replace")
    raw = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", raw)
    return _xml_text(re.sub(r"(?i)<br\s*/?>", "\n", raw), "p")


def extract(path: Path) -> Dict[str, Any]:
    ext = path.suffix.lower()
    meta: Dict[str, Any] = {"name": path.name, "mb": round(path.stat().st_size / 1048576, 2)}
    if ext in DATA_EXT:
        return {"kind": "data", "meta": meta, "text": ""}
    if ext == ".pdf":
        text, extra = _pdf(path)
        meta.update(extra)
        if extra.get("scanned"):
            return {"kind": "scan", "meta": meta, "text": text}
        return {"kind": "document", "meta": meta, "text": text}
    if ext == ".docx":
        return {"kind": "document", "meta": meta, "text": _docx(path)}
    if ext == ".pptx":
        text, extra = _pptx(path)
        meta.update(extra)
        return {"kind": "slides", "meta": meta, "text": text}
    if ext in (".html", ".htm"):
        return {"kind": "document", "meta": meta, "text": _html(path)}
    if ext in IMAGE_EXT:
        from .screen import read_image

        return {"kind": "image", "meta": meta, "text": read_image(str(path)).get("text", "")}
    if ext in MEDIA_EXT:
        from tools.transcription_tools import transcribe_audio

        result = transcribe_audio(str(path))
        return {"kind": "recording", "meta": meta, "text": (result.get("transcript") or result.get("text") or "").strip()}
    if ext in CODE_EXT:
        return {"kind": "code", "meta": meta, "text": path.read_text(encoding="utf-8", errors="replace")}
    if ext in TEXT_EXT or path.stat().st_size < 2_000_000:
        raw = path.read_bytes()[:400_000]
        if b"\x00" in raw[:4000]:
            return {"kind": "binary", "meta": meta, "text": ""}
        return {"kind": "document", "meta": meta, "text": raw.decode("utf-8", "replace")}
    return {"kind": "binary", "meta": meta, "text": ""}


_RECEIPT = re.compile(r"\b(total|subtotal|amount due|invoice|receipt|tax|gst|vat|qty|order #?)\b", re.I)
_CONTRACT = re.compile(r"\b(agreement|terms and conditions|hereby|party|parties|liabilit|terminat|indemn|governing law)\b", re.I)
_CHAT = re.compile(r"^\[?\d{1,2}[/.:-]\d{1,2}.{0,25}\]?\s*[-–]?\s*[^:]{1,30}:", re.M)


def recipe(kind: str, text: str) -> str:
    """Which cards fit this file (the model builds them)."""
    head = text[:6000]
    if kind == "code":
        return ("Code: a mindmap of its structure (title = the file, branches = main parts/classes/functions and what "
                "each does); a table of issues worth fixing (line, problem, fix), highlight the worst; a markdown card "
                "'How it works' in 4-6 bullets. Buttons on the overview: 'Explain line by line', 'Write tests', 'Fix the worst issue'.")
    if kind == "recording":
        return ("Recording: a markdown 'The gist' (4-6 bullets); a timeline of its chapters (at = rough position, label = "
                "topic); a checklist of action items or decisions if any. Buttons: 'Make flashcards', 'Quiz me', 'Write it up as an email'.")
    if kind == "image":
        return ("Image (text read by OCR): say what it is from the text. A receipt/bill: table of items + stats with the total "
                "and buttons 'Split it', 'Log this spend'. A screenshot of an error: cards for cause and fix. Otherwise a "
                "markdown card of what it says. If there's little text, say so plainly.")
    if kind == "slides":
        return ("Slides: a mindmap of the deck (centre = topic, one branch per section); a markdown 'The gist' (4-6 "
                "bullets); stats for any headline numbers. Buttons: 'Speaker notes for each slide', 'What would they ask me?', 'Quiz me'.")
    if _RECEIPT.search(head) and len(text) < 8000:
        return ("Receipt/invoice: a table of the line items (item, qty, price), highlight the biggest; stats with the total, "
                "tax and date. Buttons: 'Split it between…', 'Log this spend', 'Is anything overcharged?'.")
    if _CONTRACT.search(head):
        return ("Agreement/terms: a markdown 'In plain English' (5 bullets); a table of the key terms (term, what it means "
                "for the user); a checklist of risks or things to check before signing, worst first. Buttons: "
                "'What should I push back on?', 'Draft a reply'.")
    if len(_CHAT.findall(head)) >= 5:
        return ("Chat log: a markdown 'What happened' (4-6 bullets); cards for who said what that matters; a checklist "
                "of anything still to do. Buttons: 'Draft my reply', 'Who's upset?'.")
    return ("Document: a markdown 'The gist' (4-6 bullets, key terms bold); a mindmap of how it's organised; stats for "
            "its key numbers if it has any; a checklist of action items or deadlines if any. If it's something to learn "
            "(a report, reading, notes, slides for a class, or it's due / for an exam): also a quiz card (kind=quiz, "
            "subject = its title) with 3 short questions on the main points, left unanswered. Buttons on the gist, the 3 "
            "most useful of: 'Explain it simply', 'Make flashcards', 'Quiz me', 'Draft a reply', 'What's missing?'.")


def _progress(name: str, detail: str) -> None:
    try:
        from .workspace import deliver

        deliver({"action": "workspace", "op": "show", "artifact": {
            "id": "digest-progress", "title": f"Reading {name[:60]}", "kind": "progress",
            "progress": {"label": detail[:80], "message": "Breaking it down…"}}})
    except Exception:
        pass


def handle(params: Dict[str, Any], **_: Any) -> str:
    raw = str(params.get("path") or "").strip().strip('"').lstrip("@").removeprefix("file:")
    path = Path(raw).expanduser()
    if not path.is_file():
        return json.dumps({"ok": False, "error": f"No file at {raw}"})
    ext = path.suffix.lower()
    _progress(path.name, "listening to it on this PC" if ext in MEDIA_EXT else "reading it on this PC")
    try:
        got = extract(path)
    except Exception as exc:
        return json.dumps({"ok": False, "error": f"Couldn't read {path.name}: {exc}"})
    finally:
        try:
            from .workspace import deliver

            deliver({"action": "workspace", "op": "remove", "id": "digest-progress"})
        except Exception:
            pass
    kind, text = got["kind"], got["text"]
    if kind == "data":
        return json.dumps({"ok": True, "kind": "data", "note": f"A data file: call vyrse_analyse with path={path} now (it builds the dashboard)."})
    if kind == "binary" or not text.strip():
        return json.dumps({"ok": False, "kind": kind, "error": f"There's no readable text in {path.name}."
                           + (" It looks like a scanned PDF: open a page and I can read it off the screen." if kind == "scan" else "")})
    cut = len(text) > MAX_TEXT
    return json.dumps({"ok": True, "kind": kind, "file": got["meta"],
                       "text": text[:MAX_TEXT] + ("\n…(cut here; the rest is in the file)" if cut else ""),
                       "cards": recipe(kind, text),
                       "note": "Build those cards now with vyrse_workspace (one call each, buttons as 'Label :: message'), "
                               "then reply with the headline in two sentences. Use only what's in the file."},
                      ensure_ascii=False)
