"""The behaviours the reels show: sorting a folder (and undoing it), alarms, threshold alerts, the per-turn hints."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from vyrse.files import organize  # noqa: E402
from vyrse import reminders, system, workspace  # noqa: E402


def test_organize_sorts_skips_renames_and_undoes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(workspace, "deliver", lambda *a, **k: True)
    d = tmp_path / "Downloads"
    d.mkdir()
    for name in ("a.png", "b.PDF", "setup.exe", "x.zip", "clip.mp4", "odd.qqq", "half.crdownload", "desktop.ini"):
        (d / name).write_text("x")
    (d / "Images").mkdir()
    (d / "Images" / "a.png").write_text("old")
    (d / "keep").mkdir()

    out = organize.organize(str(d), confirmed=True)
    assert out["ok"] and out["moved"] == 6 and out["deleted"] == 0 and out["left_alone"] == 2
    assert (d / "Images" / "a (2).png").exists() and (d / "Images" / "a.png").read_text() == "old"
    assert (d / "Documents" / "b.PDF").exists() and (d / "Other" / "odd.qqq").exists()
    assert (d / "half.crdownload").exists() and (d / "keep").is_dir()

    back = organize.undo(d)
    assert back["ok"] and back["moved_back"] == 6
    assert sorted(p.name for p in d.iterdir()) == sorted(
        ["a.png", "b.PDF", "setup.exe", "x.zip", "clip.mp4", "odd.qqq", "half.crdownload", "desktop.ini", "Images", "keep"])
    assert [p.name for p in (d / "Images").iterdir()] == ["a.png"]
    assert not organize.undo(d)["ok"]  # nothing left to undo


def test_organize_needs_a_yes(tmp_path, monkeypatch):
    from vyrse import confirm

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "f.png").write_text("x")
    monkeypatch.setattr(confirm, "ask", lambda *a, **k: "Cancel")
    out = organize.organize(str(tmp_path))
    assert out.get("cancelled") and (tmp_path / "f.png").exists()


def test_alarm_clock_times():
    assert reminders._clock("8:30").strftime("%H:%M") == "08:30"
    assert reminders._clock("7 pm").strftime("%H:%M") == "19:00"
    assert reminders._clock("12am").strftime("%H:%M") == "00:00"
    assert reminders._clock("25:00") is None and reminders._clock("tomorrow") is None


def test_watch_alerts_once_per_crossing(monkeypatch):
    fired = []
    monkeypatch.setattr(system, "_alert", lambda metric, value, line, above, phone: fired.append((value, above, phone)))
    readings = iter([70, 79, 81, 84, 82, 76, 83, 60])
    monkeypatch.setattr(system, "_read", lambda metric, last: next(readings))
    monkeypatch.setattr(workspace, "deliver", lambda *a, **k: True)

    import gateway.session_context as sc
    monkeypatch.setattr(sc, "get_session_env", lambda *a, **k: "test")
    import threading
    done = threading.Event()
    real_thread = threading.Thread

    class Inline(real_thread):  # run the watch loop right here instead of in the background
        def start(self):
            try:
                self.run()
            except StopIteration:
                pass
            done.set()

    monkeypatch.setattr(threading, "Thread", Inline)
    monkeypatch.setattr(threading.Event, "wait", lambda self, t=None: self.is_set())
    out = system._watch("gpu_temp", 1, 1, above=80, phone=True)
    assert done.is_set() and out["alert"].startswith("above 80")
    # 81 crosses; 84/82 stay over (no repeat); 76 re-arms (< 77); 83 crosses again
    assert [f[0] for f in fired] == [81, 83] and all(f[1] and f[2] for f in fired)


def test_hints_for_reel_requests():
    def first(text):
        found = workspace.hints(text)
        return found[0] if found else ""

    assert "alarm=true" in first("set an alarm for 8:30")
    assert "action=organize" in first("VYRSE, clean up my downloads folder")
    assert "action=arrange" in first("clean up my windows")
    assert "action=usage" in first("how long have I been gaming today?")
    assert "alert_above" in first("ping my phone if my GPU goes over 80 degrees")
    assert "lock" in first("I'm heading out")
    assert workspace.hints("what's the weather") == []
