import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin

from vyrse import analyse  # noqa: E402

CSV = """date,category,item,amount
2026-09-01,Food,lunch,₹12.50
2026-09-02,Games,skin,₹40
2026-09-15,Games,dlc,"₹1,000.00"
2026-09-20,Food,dinner,₹20
2026-09-28,Transport,bus,₹3.25
"""


def test_csv_totals_groups_and_board(tmp_path, monkeypatch):
    from vyrse import tools, workspace

    f = tmp_path / "spending.csv"
    f.write_text(CSV, encoding="utf-8")
    header, rows = analyse.load(str(f))
    cols = analyse.pick_columns(header, rows)
    assert (header[cols["value"]], header[cols["group"]], header[cols["date"]]) == ("amount", "category", "date")
    info = analyse.analyse(header, rows, cols, "Spending")
    assert info["total"] == 1075.75 and info["sym"] == "₹"
    assert list(info["groups"].items())[0] == ("Games", (1040.0, 2))
    assert info["series"][0] == {"label": "01 Sep", "value": 12.5}

    shown = []
    monkeypatch.setattr(tools, "_in_vyrse_session", lambda: True)
    monkeypatch.setattr(workspace, "deliver", lambda payload, **kw: shown.append(payload["artifact"]) or True)
    res = json.loads(analyse.handle({"path": str(f)}))
    assert res["success"] and "₹1,075.75" in res["result"] and "Games ₹1,040.00 (96.7%, 2 entries)" in res["result"]
    kinds = [a["kind"] for a in shown]
    assert kinds == ["table", "series", "series", "stats"]  # the summary last, so it lands on top
    assert shown[0]["table"]["highlight"] == 0 and shown[2]["chart"]["style"] == "donut"
    assert shown[3]["stats"][1] == {"label": "Top category", "value": "Games", "note": "₹1,040.00 · 97%"}


def test_xlsx_and_json(tmp_path):
    x = tmp_path / "grades.xlsx"
    sheet = ('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
             '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
             '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>78</v></c></row>'
             '<row r="3"><c r="A3" t="inlineStr"><is><t>Maths</t></is></c><c r="B3"><v>91</v></c></row>'
             '<row r="4"><c r="A4" t="s"><v>2</v></c><c r="B4"><v>64</v></c></row>'
             '</sheetData></worksheet>')
    shared = ('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<si><t>subject</t></si><si><t>score</t></si><si><t>Physics</t></si></sst>')
    with zipfile.ZipFile(x, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml", sheet)
        z.writestr("xl/sharedStrings.xml", shared)
    header, rows = analyse.load(str(x))
    assert header == ["subject", "score"] and rows == [["Physics", "78"], ["Maths", "91"], ["Physics", "64"]]
    info = analyse.analyse(header, rows, analyse.pick_columns(header, rows))
    assert info["groups"] == {"Physics": (142.0, 2), "Maths": (91.0, 1)}

    j = tmp_path / "steps.json"
    j.write_text(json.dumps({"days": [{"day": "2026-10-01", "steps": 4000}, {"day": "2026-10-02", "steps": 9000}]}))
    header, rows = analyse.load(str(j))
    info = analyse.analyse(header, rows, analyse.pick_columns(header, rows))
    assert info["total"] == 13000 and info["span"] == "2026-10-01 to 2026-10-02"


def test_bad_files(tmp_path):
    assert not json.loads(analyse.handle({"path": str(tmp_path / "nope.csv")}))["success"]
    (tmp_path / "a.pdf").write_text("x")
    assert "CSV, TSV, Excel" in json.loads(analyse.handle({"path": str(tmp_path / "a.pdf")}))["error"]
