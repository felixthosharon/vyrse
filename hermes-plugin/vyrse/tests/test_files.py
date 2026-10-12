import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # .../hermes-plugin


def test_empty_dated_search_widens_to_any_time(monkeypatch):
    from vyrse import files

    calls = []

    def fake_run(request, timeout=25):
        calls.append(request)
        if "modified" in request:
            return {"ok": True, "count": 0, "results": []}
        return {"ok": True, "count": 1, "results": [{"name": "Survey.pdf"}]}

    monkeypatch.setattr(files, "run", fake_run)
    out = json.loads(files.handle({"action": "find", "kind": "pdf", "modified": "week", "path": ""}))
    assert out["results"][0]["name"] == "Survey.pdf" and "any time" in out["note"]
    assert calls[0] == {"action": "find", "kind": "pdf", "modified": "week"}  # empty values aren't passed on
    assert "modified" not in calls[1]
