"""`vyrse_analyse`: exact analysis of a data file (CSV, TSV, Excel, JSON), shown as a workspace dashboard.

Small local models "analyse" a file by eyeballing it and get the totals wrong. This does the arithmetic in
code: it finds the amount column, a category to group by and a date column, then builds totals per group,
the trend over time and the headline numbers, puts them on the board, and hands the model exact figures to
quote. No pandas needed (Hermes' venv doesn't have it): .xlsx is read straight from its XML.
"""
from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from xml.etree import ElementTree as ET

SCHEMA: Dict[str, Any] = {
    "name": "vyrse_analyse",
    "description": (
        "Analyse a data file exactly (CSV, TSV, Excel .xlsx, JSON list): totals per category, the trend over "
        "time, top items and headline numbers, computed in code and shown as a dashboard in the workspace. "
        "Use it whenever the user asks to analyse, break down or summarise a spreadsheet or data file (spending, "
        "sales, grades, logs, exports); quote its numbers, never your own. Columns are picked automatically; "
        "pass by / value / date only if the user names them."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "The data file."},
            "by": {"type": "string", "description": "Column to group by (optional), e.g. 'category'."},
            "value": {"type": "string", "description": "Numeric column to add up (optional), e.g. 'amount'."},
            "date": {"type": "string", "description": "Date column (optional)."},
            "title": {"type": "string", "description": "What the data is, e.g. 'September spending'."},
        },
        "required": ["path"],
    },
}

_MAX_ROWS = 200_000
_CURRENCY = re.compile(r"[₹$€£¥]")
_NUM = re.compile(r"^[-+(]?\s*[₹$€£¥]?\s*[-+]?\d[\d,]*(?:\.\d+)?\s*%?\)?$")
_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%d-%m-%Y", "%m/%d/%Y", "%d.%m.%Y", "%Y-%m-%d %H:%M:%S",
                 "%Y-%m-%dT%H:%M:%S", "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y")
_VALUE_HINTS = ("amount", "total", "price", "cost", "spent", "value", "sum", "revenue", "sales", "paid", "minutes",
                "mins", "hours", "score", "qty", "quantity", "count", "duration", "calories", "distance")
_GROUP_HINTS = ("category", "type", "group", "kind", "class", "subject", "merchant", "vendor", "store", "app",
                "product", "item", "name", "account", "tag", "label", "department", "region", "status")


# --------------------------------------------------------------------------------------------- loading

def _read_xlsx(path: Path) -> List[List[str]]:
    """First worksheet of an .xlsx as rows of text (shared strings and inline strings resolved)."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as z:
        shared: List[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
        sheets = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
        if not sheets:
            raise ValueError("no worksheet in that file")
        root = ET.fromstring(z.read(sheets[0]))
    rows: List[List[str]] = []
    for row in root.iter(f"{{{ns['m']}}}row"):
        cells: Dict[int, str] = {}
        for c in row.findall("m:c", ns):
            ref = re.match(r"([A-Z]+)", c.get("r") or "")
            col = 0
            for ch in ref.group(1) if ref else "":
                col = col * 26 + ord(ch) - 64
            kind, v = c.get("t"), c.find("m:v", ns)
            if kind == "s" and v is not None:
                text = shared[int(v.text or 0)]
            elif kind == "inlineStr":
                text = "".join(t.text or "" for t in c.iter(f"{{{ns['m']}}}t"))
            else:
                text = v.text if v is not None and v.text else ""
            cells[max(col - 1, len(cells)) if not ref else col - 1] = text
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
        if len(rows) > _MAX_ROWS:
            break
    return rows


def load(path: str) -> Tuple[List[str], List[List[str]]]:
    file = Path(path.strip().strip('"')).expanduser()
    if not file.is_file():
        raise ValueError(f"no file at {path}")
    ext = file.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        grid = _read_xlsx(file)
    elif ext == ".json":
        data = json.loads(file.read_text(encoding="utf-8-sig"))
        if isinstance(data, dict):
            data = next((v for v in data.values() if isinstance(v, list)), [data])
        if not isinstance(data, list) or not data or not all(isinstance(r, dict) for r in data[:50]):
            raise ValueError("the JSON file isn't a list of records")
        header = list(dict.fromkeys(k for r in data[:500] for k in r))
        grid = [header] + [["" if r.get(k) is None else str(r.get(k)) for k in header] for r in data[:_MAX_ROWS]]
    elif ext in (".csv", ".tsv", ".txt"):
        text = file.read_text(encoding="utf-8-sig", errors="replace")
        try:
            dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel_tab if ext == ".tsv" else csv.excel
        grid = [r for r in csv.reader(io.StringIO(text), dialect) if any(c.strip() for c in r)][: _MAX_ROWS + 1]
    else:
        raise ValueError("I can analyse CSV, TSV, Excel (.xlsx) and JSON files")
    if len(grid) < 2:
        raise ValueError("the file has no data rows")
    width = max(len(r) for r in grid[:200])
    header = [(h or f"column {i + 1}").strip() for i, h in enumerate(grid[0] + [""] * (width - len(grid[0])))]
    return header, [r + [""] * (width - len(r)) for r in grid[1:]]


# ------------------------------------------------------------------------------------------ columns

def _num(cell: str) -> Optional[float]:
    s = cell.strip()
    if not s or not _NUM.match(s):
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = _CURRENCY.sub("", s).replace(",", "").replace("%", "").strip("()+ ")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def _date(cell: str) -> Optional[date]:
    s = cell.strip()
    if not s or len(s) > 32:
        return None
    if re.fullmatch(r"\d{5}(?:\.\d+)?", s):  # an Excel serial day
        n = float(s)
        if 20000 < n < 80000:
            return date.fromordinal(date(1899, 12, 30).toordinal() + int(n))
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _share(rows: List[List[str]], i: int, test) -> float:
    cells = [r[i] for r in rows[:2000] if r[i].strip()]
    return sum(1 for c in cells if test(c) is not None) / len(cells) if cells else 0.0


def _find(header: List[str], wanted: str) -> Optional[int]:
    w = wanted.strip().lower()
    for i, h in enumerate(header):
        if h.lower() == w:
            return i
    return next((i for i, h in enumerate(header) if w and w in h.lower()), None)


def pick_columns(header: List[str], rows: List[List[str]], by: str = "", value: str = "", when: str = "") -> Dict[str, Optional[int]]:
    dates = [i for i in range(len(header)) if _share(rows, i, _date) >= 0.8]
    nums = [i for i in range(len(header)) if i not in dates and _share(rows, i, _num) >= 0.8]
    # Id-like or year-like numbers aren't amounts.
    nums = [i for i in nums if not re.search(r"\b(id|no|number|year|zip|phone|code)\b", header[i].lower())]
    texts = [i for i in range(len(header)) if i not in dates and i not in nums]

    def hinted(cands: List[int], hints: Tuple[str, ...]) -> Optional[int]:
        for hint in hints:
            for i in cands:
                if hint in header[i].lower():
                    return i
        return None

    v = _find(header, value) if value else None
    if v is None:
        v = hinted(nums, _VALUE_HINTS) if nums else None
        if v is None and nums:
            v = max(nums, key=lambda i: sum(abs(_num(r[i]) or 0) for r in rows))
    g = _find(header, by) if by else None
    if g is None:
        groupable = [i for i in texts if 2 <= len({r[i].strip() for r in rows if r[i].strip()}) <= max(30, len(rows) // 3)]
        g = hinted(groupable, _GROUP_HINTS)
        if g is None and groupable:
            g = min(groupable, key=lambda i: len({r[i] for r in rows}))
    d = _find(header, when) if when else (dates[0] if dates else None)
    return {"value": v, "group": g, "date": d}


# ----------------------------------------------------------------------------------------- analysis

def _fmt(v: float, sym: str = "") -> str:
    """Money with two decimals (₹1,040.00); other measures as plain as they are (9,000 / 12.5)."""
    s = f"{v:,.2f}" if sym else (f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}".rstrip("0").rstrip("."))
    return f"-{sym}{s[1:]}" if s.startswith("-") else f"{sym}{s}"


def analyse(header: List[str], rows: List[List[str]], cols: Dict[str, Optional[int]], title: str = "") -> Dict[str, Any]:
    vi, gi, di = cols["value"], cols["group"], cols["date"]
    sym = ""
    if vi is not None:
        found = Counter(m.group(0) for r in rows[:500] for m in [_CURRENCY.search(r[vi])] if m)
        sym = found.most_common(1)[0][0] if found else ""
    amount = (lambda r: _num(r[vi]) or 0.0) if vi is not None else (lambda r: 1.0)
    measure = header[vi] if vi is not None else "rows"
    used = [r for r in rows if vi is None or _num(r[vi]) is not None]
    total = sum(amount(r) for r in used)
    groups: Dict[str, Tuple[float, int]] = {}
    if gi is not None:
        acc: Dict[str, List[float]] = defaultdict(lambda: [0.0, 0])
        for r in used:
            key = r[gi].strip() or "(blank)"
            acc[key][0] += amount(r)
            acc[key][1] += 1
        groups = {k: (round(v[0], 2), int(v[1])) for k, v in sorted(acc.items(), key=lambda kv: -kv[1][0])}
    series: List[Dict[str, Any]] = []
    span = ""
    halves = None
    if di is not None:
        dated = [(d, amount(r)) for r in used for d in [_date(r[di])] if d]
        if dated:
            first, last = min(d for d, _ in dated), max(d for d, _ in dated)
            span = f"{first.isoformat()} to {last.isoformat()}"
            monthly = (last - first).days > 62
            bucket: Dict[Any, float] = defaultdict(float)
            for d, v in dated:
                bucket[(d.year, d.month) if monthly else d] += v
            for k in sorted(bucket):
                label = date(k[0], k[1], 1).strftime("%b %Y") if monthly else k.strftime("%d %b")
                series.append({"label": label, "value": round(bucket[k], 2)})
            mid = first.toordinal() + ((last - first).days + 1) / 2
            a = sum(v for d, v in dated if d.toordinal() < mid)
            b = sum(v for d, v in dated if d.toordinal() >= mid)
            halves = (a, b)
    biggest = max(used, key=amount) if used and vi is not None else None
    return {
        "title": title, "measure": measure, "sym": sym, "rows": len(used), "total": round(total, 2),
        "average": round(total / len(used), 2) if used else 0.0, "groups": groups,
        "group_name": header[gi] if gi is not None else "", "series": series, "span": span, "halves": halves,
        "biggest": {"value": amount(biggest), "label": (biggest[gi] if gi is not None else "") or "",
                    "when": (biggest[di] if di is not None else "")} if biggest else None,
    }


def board(info: Dict[str, Any], slug: str) -> List[Dict[str, Any]]:
    """The dashboard, in the order to show it (the summary last, so it lands on top)."""
    from .workspace import build_artifact

    sym, title, items = info["sym"], info["title"] or "Your data", []
    groups = info["groups"]
    if groups:
        top = list(groups.items())
        items.append(build_artifact({
            "kind": "table", "id": f"{slug}-table", "title": f"{title} · by {info['group_name']}",
            "columns": [info["group_name"].title(), info["measure"].title(), "Share", "Entries"],
            "rows": [[k, _fmt(v, sym), f"{(v / info['total'] * 100) if info['total'] else 0:.1f}%", n] for k, (v, n) in top[:50]],
            "highlight": top[0][0]}))
    if len(info["series"]) >= 2:
        items.append(build_artifact({"kind": "chart", "style": "line", "id": f"{slug}-trend", "title": f"{title} · over time",
                                     "points": info["series"][-120:]}))
    if groups:
        shown = list(groups.items())[:15]
        style = "donut" if len(groups) <= 6 else "bar"
        items.append(build_artifact({"kind": "chart", "style": style, "id": f"{slug}-groups", "title": f"{title} · where it goes" if sym else f"{title} · by {info['group_name']}",
                                     "points": [{"label": k[:24], "value": v} for k, (v, _) in shown],
                                     **({"highlight": shown[0][0][:24]} if style == "bar" else {})}))
    stats = [{"label": "Total", "value": _fmt(info["total"], sym), "note": f"{info['rows']} entries"}]
    if groups:
        k, (v, _) = next(iter(groups.items()))
        stats.append({"label": f"Top {info['group_name']}", "value": k[:24], "note": f"{_fmt(v, sym)} · {v / info['total'] * 100 if info['total'] else 0:.0f}%"})
    stats.append({"label": "Average", "value": _fmt(info["average"], sym), "note": "per entry"})
    if info["halves"] and info["halves"][0] > 0:
        a, b = info["halves"]
        stats.append({"label": "Second half", "value": _fmt(b, sym), "change": f"{(b - a) / a * 100:+.0f}%",
                      "note": "vs first half", **({"trend": [p["value"] for p in info["series"][-30:]]} if len(info["series"]) >= 3 else {})})
    items.append(build_artifact({"kind": "stats", "id": f"{slug}-summary", "title": title, "items": stats,
                                 **({"caption": info["span"]} if info["span"] else {})}))
    return items


def summary_text(info: Dict[str, Any]) -> str:
    sym = info["sym"]
    parts = [f"{info['rows']} entries" + (f" from {info['span']}" if info["span"] else "") +
             f"; total {info['measure']}: {_fmt(info['total'], sym)}; average per entry {_fmt(info['average'], sym)}."]
    if info["groups"]:
        top = [f"{k} {_fmt(v, sym)} ({v / info['total'] * 100 if info['total'] else 0:.1f}%, {n} entries)" for k, (v, n) in list(info["groups"].items())[:6]]
        parts.append(f"By {info['group_name']}, largest first: " + "; ".join(top) + ".")
    if info["halves"] and info["halves"][0] > 0:
        a, b = info["halves"]
        parts.append(f"First half {_fmt(a, sym)}, second half {_fmt(b, sym)} ({(b - a) / a * 100:+.0f}%).")
    if info["biggest"]:
        bg = info["biggest"]
        parts.append(f"Biggest single entry: {_fmt(bg['value'], sym)}" + (f" ({bg['label']}" + (f", {bg['when']})" if bg["when"] else ")") if bg["label"] else "") + ".")
    return " ".join(parts)


def handle(params: Dict[str, Any], **_: Any) -> str:
    try:
        header, rows = load(str(params.get("path") or ""))
        cols = pick_columns(header, rows, str(params.get("by") or ""), str(params.get("value") or ""), str(params.get("date") or ""))
        title = str(params.get("title") or "").strip()[:60] or Path(str(params["path"]).strip('"')).stem.replace("_", " ").replace("-", " ").title()
        info = analyse(header, rows, cols, title)
    except (OSError, ValueError, zipfile.BadZipFile, ET.ParseError, json.JSONDecodeError) as exc:
        return json.dumps({"success": False, "error": f"couldn't analyse that file: {exc}"})
    shown = ""
    try:
        from .tools import _in_vyrse_session

        if _in_vyrse_session():
            from . import workspace

            slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:30] or "data"
            for art in board(info, slug):
                workspace.deliver({"action": "workspace", "op": "show", "artifact": art})
            shown = (" The full dashboard (summary, breakdown chart, trend, table) is already on screen: don't call "
                     "vyrse_workspace for it.")
    except Exception as exc:  # the numbers still go back to the model
        shown = f" (Couldn't show it in the workspace: {exc})"
    return json.dumps({"success": True, "columns": header, "used": {k: (header[v] if v is not None else None) for k, v in cols.items()},
                       "result": summary_text(info) + shown + " Reply with the headline finding in a sentence or two, "
                       "using these exact numbers."}, ensure_ascii=False)
