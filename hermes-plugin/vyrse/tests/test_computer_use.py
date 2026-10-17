"""Looking before acting (see.py), the user's own Chrome (chrome.py) and looking steps up (privacy of it)."""
import json
import socket
import threading

import pytest


def test_parse_choice_only_accepts_drawn_numbers():
    from vyrse import see

    assert see.parse_choice('{"mark": 3, "why": "gear icon"}', 5) == 3
    assert see.parse_choice('```json\n{"mark": 2}\n```', 5) == 2
    assert see.parse_choice('{"mark": null, "why": "not there"}', 5) is None
    assert see.parse_choice('{"mark": 9}', 5) is None  # never drawn: rejected, not clamped
    assert see.parse_choice("none of them", 5) is None
    assert see.parse_choice("4", 5) == 4


def test_shortlist_puts_word_matches_then_unlabeled_icons_first():
    from vyrse import see

    items = [
        {"type": "Text", "name": "Settings are saved", "rect": {"x": 0, "y": 300, "width": 90, "height": 20}},
        {"type": "Button", "name": "", "rect": {"x": 500, "y": 10, "width": 30, "height": 30}},
        {"type": "Button", "name": "Open settings", "rect": {"x": 10, "y": 10, "width": 30, "height": 30}},
        {"type": "Button", "name": "Help", "rect": {"x": 60, "y": 10, "width": 30, "height": 30}},
    ]
    got = [i["name"] for i in see.shortlist(items, "settings")]
    assert got[:2] == ["Open settings", "Settings are saved"]
    assert got[2] == ""  # the unlabeled icon button comes before ordinary labeled ones
    assert see.label_of({"name": "", "help": "Search (Ctrl+F)"}) == "Search (Ctrl+F)"


def test_marks_are_drawn_on_the_screenshot():
    import io

    from PIL import Image

    from vyrse import see

    buf = io.BytesIO()
    Image.new("RGB", (400, 300), "white").save(buf, "PNG")
    out = see.draw_marks(buf.getvalue(), [{"rect": {"x": 1100, "y": 520, "width": 40, "height": 40}}], origin=(1000, 500))
    img = Image.open(io.BytesIO(out)).convert("RGB")
    assert img.size == (400, 300)
    assert img.getpixel((100, 40)) != (255, 255, 255)  # the box outline sits where the control is


def test_filler_words_are_dropped_before_matching_labels():
    from vyrse import point

    assert point._plain("the Eraser button") == "Eraser"
    assert point._plain("a Save icon") == "Save"
    assert point._plain("Tab") == "Tab"


def test_private_mode_counts_chrome_and_lookups_as_online():
    from vyrse import privacy

    assert privacy.is_online("vyrse_chrome", {"action": "read"})
    assert privacy.is_online("vyrse_point", {"action": "how", "goal": "dark mode"})
    assert not privacy.is_online("vyrse_point", {"action": "show", "target": "File"})


def test_chrome_controls_are_listed_for_the_model():
    from vyrse import chrome

    assert chrome._element_line({"ref": 4, "type": "button", "name": "Subscribe"}) == '[4] button "Subscribe"'
    line = chrome._element_line({"ref": 7, "type": "button", "name": "", "icon": True, "hint": "bell-icon"})
    assert line == "[7] button (icon, no label) icon:bell-icon"
    assert chrome._element_line({"ref": 2, "type": "checkbox", "name": "Remember me", "checked": False}).endswith("(off)")


def test_extension_files_install_with_this_pcs_token(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from vyrse import chrome

    dest = chrome.install_extension()
    assert dest is not None and (dest / "manifest.json").is_file() and (dest / "background.js").is_file()
    config = (dest / "config.js").read_text(encoding="utf-8")
    assert chrome.token() in config and f"port: {chrome.PORT}" in config
    manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["manifest_version"] == 3 and "debugger" in manifest["permissions"]


@pytest.fixture()
def bridge(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from vyrse import chrome

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setattr(chrome, "PORT", port)
    monkeypatch.setattr(chrome, "_server_started", False)
    monkeypatch.setattr(chrome, "_conn", None)
    assert chrome.start_server()
    return chrome


def _extension(chrome, token=None, origin="chrome-extension://abcdefghijklmnopabcdefghijklmnop"):
    from websockets.sync.client import connect

    ws = connect(f"ws://127.0.0.1:{chrome.PORT}/", origin=origin, open_timeout=5)
    ws.send(json.dumps({"type": "hello", "token": token or chrome.token(), "version": "test"}))
    return ws


def test_chrome_bridge_round_trip(bridge):
    chrome = bridge
    ws = _extension(chrome)
    assert json.loads(ws.recv(timeout=5))["type"] == "welcome"

    def fake_chrome():
        msg = json.loads(ws.recv(timeout=5))
        assert msg["cmd"] == "tabs"
        ws.send(json.dumps({"type": "result", "id": msg["id"], "ok": True, "result": {"tabs": [{"tab": 1, "title": "Inbox"}]}}))
        msg = json.loads(ws.recv(timeout=5))
        ws.send(json.dumps({"type": "result", "id": msg["id"], "ok": False, "error": "Element 9 is gone"}))

    worker = threading.Thread(target=fake_chrome)
    worker.start()
    assert chrome.connected()
    assert json.loads(chrome.handle({"action": "tabs"})) == {"ok": True, "tabs": [{"tab": 1, "title": "Inbox"}]}
    assert json.loads(chrome.handle({"action": "click", "ref": 9})) == {"ok": False, "error": "Element 9 is gone"}
    worker.join(5)
    ws.close()


def test_chrome_bridge_turns_away_strangers(bridge):
    chrome = bridge
    ws = _extension(chrome, token="wrong")
    with pytest.raises(Exception):
        ws.recv(timeout=5)  # closed: bad token
    assert not chrome.connected()
    with pytest.raises(Exception):
        _extension(chrome, origin="https://evil.example")  # a web page can't connect
    out = json.loads(chrome.handle({"action": "tabs"}))
    assert out["ok"] is False and "chrome://extensions" in out["error"]


def test_walkthroughs_need_a_lookup_first(monkeypatch):
    import time

    from vyrse import point

    monkeypatch.setattr(point, "_private", lambda: False)
    monkeypatch.setattr(point, "_looked_up", float("-inf"))
    out = json.loads(point.handle({"action": "steps", "steps": "Settings :: open it"}))
    assert out["ok"] is False and "action=how" in out["error"]
    # after a lookup (or in Private mode, where nothing can be looked up) the walkthrough goes ahead
    monkeypatch.setattr(point, "_looked_up", time.monotonic())
    monkeypatch.setattr(point, "_in_chrome", lambda window: False)
    monkeypatch.setattr(point, "find", lambda target, window: {"ok": False, "error": "No open window matches 'Spotify'."})
    out = json.loads(point.handle({"action": "steps", "app": "Spotify", "steps": "Settings :: open it"}))
    assert "Spotify" in out["error"] and "action=how" not in out["error"]
    monkeypatch.setattr(point, "_looked_up", float("-inf"))
    monkeypatch.setattr(point, "_private", lambda: True)
    out = json.loads(point.handle({"action": "steps", "app": "Spotify", "steps": "Settings :: open it"}))
    assert "action=how" not in out["error"]


def test_where_in_the_window():
    from vyrse.point import where

    area = {"x": 300, "y": 100, "width": 1600, "height": 1000}
    assert where({"x": 549, "y": 223, "width": 32, "height": 32}, area) == "the top left"
    assert where({"x": 1000, "y": 600, "width": 32, "height": 32}, area) == "the middle"
    assert where({"x": 1800, "y": 1050, "width": 20, "height": 20}, area) == "the bottom right"
    assert where({"x": 1, "y": 1, "width": 1, "height": 1}, None) == ""


def test_text_on_screen_is_matched_word_for_word():
    from vyrse import see

    lines = [
        {"text": "File Home Insert", "words": [
            {"text": "File", "x": 20, "y": 10, "width": 30, "height": 14},
            {"text": "Home", "x": 70, "y": 10, "width": 40, "height": 14},
            {"text": "Insert", "x": 130, "y": 10, "width": 44, "height": 14}]},
        {"text": "Export to PDF", "words": [
            {"text": "Export", "x": 30, "y": 120, "width": 50, "height": 14},
            {"text": "to", "x": 84, "y": 120, "width": 14, "height": 14},
            {"text": "PDF", "x": 102, "y": 120, "width": 30, "height": 14}]},
    ]
    hits = see.text_hits(lines, "export to pdf")
    assert len(hits) == 1 and hits[0]["rect"]["x"] == 26 and hits[0]["rect"]["width"] == 110
    assert [h["text"] for h in see.text_hits(lines, "Home")] == ["Home"]
    assert see.text_hits(lines, "Settings") == []
    assert see.text_hits(lines, "Export PDF") == []  # the words must be the ones on screen, in order


def test_captions_only_start_when_asked(monkeypatch):
    from vyrse import captions, turn

    sent = []
    monkeypatch.setattr("tools.desktop_ui.emit", lambda *a, **k: sent.append(a) or True, raising=False)
    turn.pre_llm_call(platform="vyrse", user_message="highlight the file button for me")
    out = json.loads(captions.handle({"action": "start", "to": "en"}))
    assert out["ok"] is False and not sent  # the model reached for captions unasked: they stay off
    turn.pre_llm_call(platform="vyrse", user_message="[System: Continue now. Execute the required tool calls]")
    assert not captions.asked_for_captions(turn.said())  # a mid-turn nudge doesn't count as the user
    turn.pre_llm_call(platform="vyrse", user_message="translate this video thats playing")
    assert captions.asked_for_captions(turn.said())
    assert json.loads(captions.handle({"action": "stop"}))["ok"] is not None  # stopping is always allowed


def test_a_description_beats_a_stale_ref(monkeypatch):
    from vyrse import chrome

    monkeypatch.setattr(chrome, "resolve", lambda target, tab=None: {"ok": True, "rect": {"x": 1, "y": 2, "width": 3, "height": 4}, "tab": 7})
    got = chrome._target({"ref": 1, "target": "File"}, None)
    assert got["rect"] == {"x": 1, "y": 2, "width": 3, "height": 4} and "ref" not in got
    assert chrome._target({"ref": 5}, None)["ref"] == 5
    assert chrome._where({"rect": {"x": 1}}) == {"rect": {"x": 1}} and chrome._where({"ref": 2, "rect": None}) == {"ref": 2}


def test_out_of_date_extension_is_mentioned_once(bridge, monkeypatch):
    chrome = bridge
    monkeypatch.setattr(chrome, "_installed_version", lambda: "9.9.9")
    monkeypatch.setattr(chrome, "_state", {"running": "", "told": ""})
    ws = _extension(chrome)
    assert json.loads(ws.recv(timeout=5))["type"] == "welcome"
    with pytest.raises(TimeoutError):
        ws.recv(timeout=1)  # never asked to reload itself (that unloads an unpacked extension for good)
    assert "chrome://extensions" in chrome.update_note()
    assert chrome.update_note() == ""  # said once
    ws.close()


def test_reminders_repeat_only_when_asked():
    from vyrse.reminders import _repeat_rules

    args = {"schedule": "every day at 9am"}
    assert "one-time" in _repeat_rules(args, "remind me about my chemistry test tomorrow") and args["repeat"] == 1
    args = {"schedule": "0 9 * * *"}
    assert _repeat_rules(args, "remind me about the test tomorrow morning") and args["repeat"] == 1
    args = {"schedule": "every day at 8am"}
    assert _repeat_rules(args, "remind me every morning to stretch") == "" and "repeat" not in args
    args = {"schedule": "every 5m"}
    assert "30 minutes" in _repeat_rules(args, "keep reminding me to drink water every hour or so") and args["schedule"] == "every 30m"
    args = {"schedule": "every 10m"}
    assert _repeat_rules(args, "remind me every 10 minutes to check the oven") == ""
    args = {"schedule": "in 2h"}
    assert _repeat_rules(args, "remind me in 2 hours") == "" and "repeat" not in args


def test_late_repeats_are_dropped_but_late_one_offs_kept(monkeypatch):
    import cron.jobs
    from vyrse import reminders

    jobs = {
        "daily": {"schedule": {"kind": "cron"}, "repeat": {"times": None}, "last_dispatch": {"kind": "catch_up", "lateness_seconds": 38000}},
        "once": {"schedule": {"kind": "once"}, "repeat": {"times": 1}, "last_dispatch": {"kind": "catch_up", "lateness_seconds": 38000}},
        "ontime": {"schedule": {"kind": "cron"}, "repeat": {"times": None}, "last_dispatch": {"kind": "on_time", "lateness_seconds": 2}},
    }
    monkeypatch.setattr(cron.jobs, "get_job", lambda job_id: jobs.get(job_id))
    assert reminders._stale_repeat("daily") and not reminders._stale_repeat("once") and not reminders._stale_repeat("ontime")


def test_onscreen_requests_are_routed_and_split():
    from vyrse import onscreen

    assert onscreen.wants_onscreen("can u highlight where to click") == "guide"
    assert onscreen.wants_onscreen("export this as pdf right away through controlling my screen") == "do"
    assert onscreen.wants_onscreen("do it for me") == "do"
    assert onscreen.wants_onscreen("what's the weather tomorrow") is None
    assert onscreen.wants_onscreen("remind me to call mum") is None
    got = onscreen._requests("Download as PDF ... Export document as a PDF without any comments", "Select the PDF type")
    assert got[0] == "Download as PDF" and len(got) <= 4
    assert onscreen._requests("select File", "")[0] == "File"
    assert onscreen._site_name("https://word.cloud.microsoft/open/onedrive/?docId=1", "SIT379.docx") == "Word for the web"
    assert onscreen._site_name("https://example.org/x", "Example") == "example.org (website)"


def test_everyday_times_become_one_shot_times():
    import datetime as dt

    from vyrse.reminders import _plain_time

    tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
    assert _plain_time("tomorrow at 9am") == f"{tomorrow}T09:00:00"
    assert _plain_time("9am tomorrow") == f"{tomorrow}T09:00:00"
    assert _plain_time("tonight at 8").endswith("T20:00:00")
    assert _plain_time("every day at 9am") == "every day at 9am"
    assert _plain_time("in 2h") == "in 2h"


def test_names_and_classes_pick_a_control_without_guessing():
    from vyrse import see

    chrome_bar = [
        {"type": "Button", "name": "Reload", "cls": "ReloadButton", "rect": {"x": 0, "y": 0, "width": 30, "height": 30}},
        {"type": "Button", "name": "Felix", "cls": "AvatarToolbarButton", "rect": {"x": 900, "y": 0, "width": 30, "height": 30}},
        {"type": "Button", "name": "Chrome", "cls": "BrowserAppMenuButton", "rect": {"x": 940, "y": 0, "width": 30, "height": 30}},
        {"type": "Button", "name": "New Tab", "cls": "TabStripControlButton", "rect": {"x": 300, "y": 0, "width": 30, "height": 30}},
        {"type": "Button", "name": "Tab search", "cls": "TabStripFlatEdgeButton", "rect": {"x": 10, "y": 0, "width": 30, "height": 30}},
    ]
    assert see._by_words(chrome_bar, "Profile (At the top right, select Profile)")["name"] == "Felix"
    assert see._by_words(chrome_bar, "the three dots menu")["name"] == "Chrome"
    assert see._by_words(chrome_bar, "the new tab plus")["name"] == "New Tab"
    assert see._by_words(chrome_bar, "a rocket") is None  # nothing shares a word: the vision model decides
    paint = [{"type": "Button", "name": "Fill", "rect": {"x": 0, "y": 0, "width": 30, "height": 30}},
             {"type": "Button", "name": "Paint settings", "rect": {"x": 40, "y": 0, "width": 30, "height": 30}}]
    # "paint" is the app's own name, not a clue about which control
    assert see._by_words(paint, "the paint bucket", ignore="the window 'Untitled - Paint' (mspaint)") is None


def test_next_step_only_while_a_walkthrough_runs():
    from vyrse import onscreen

    onscreen._active.clear()
    assert onscreen.next_step() is False
    onscreen._active.set()
    try:
        assert onscreen.next_step() is True and onscreen._next.is_set()
        hint = onscreen.pre_llm_call(platform="vyrse", user_message="step 2?")
        assert "action=next" in hint["context"]
    finally:
        onscreen._active.clear()
        onscreen._next.clear()


def test_caption_requests_are_handled_typos_and_all(monkeypatch):
    from vyrse import captions, turn

    sent = []
    monkeypatch.setattr("tools.desktop_ui.emit", lambda event, payload: sent.append(payload) or True, raising=False)

    def on(text):
        turn.pre_llm_call(platform="vyrse", user_message=text)
        return (captions.pre_llm_call(platform="vyrse", user_message=text) or {}).get("context", "")

    captions._running = False
    assert "captions ON" in on("i dont understant this, transalte plz") and sent[-1]["op"] == "start"
    assert "captions OFF" in on("close the caption bar") and sent[-1]["op"] == "stop"
    assert "Spanish" in on("turn on subtitles in spanish") and sent[-1]["to"] == "es"
    captions._running = False
    assert on('translate "hola amigo como estas hoy" to english') == ""  # their own text, not the video
    assert on("what's the weather") == "" and on("highlight the export button") == ""


def test_known_sites_are_opened_not_guessed():
    from vyrse import navigator

    s = navigator.site_for("access gmail account settings", "chrome://newtab/")
    assert s["host"] == "mail.google.com" and s["settings"].endswith("#settings/general")
    assert navigator.site_for("open gmail settings", "https://mail.google.com/mail/u/0/#inbox") is None  # already there
    assert navigator.site_for("manage my google account", "")["host"] == "myaccount.google.com"
    assert navigator.site_for("export this as pdf", "https://word.cloud.microsoft/x") is None


def test_ring_captions_drop_the_models_bookkeeping():
    from vyrse.navigator import caption_for

    assert caption_for("File", "Clicking the 'File' menu (control 3) is the first step to export.") == "Click File"
    assert "control" not in caption_for("Download", "The PDF is ready (control 5), so download it now.")


def test_the_planner_only_accepts_what_it_was_shown(monkeypatch):
    import io

    from PIL import Image

    from vyrse import navigator, see

    buf = io.BytesIO()
    Image.new("RGB", (300, 200), "white").save(buf, "PNG")
    view = {"png": buf.getvalue(), "area": {"x": 0, "y": 0}, "popups": 0, "viewport": None,
            "items": [{"type": "Button", "name": "File", "rect": {"x": 10, "y": 10, "width": 40, "height": 20}},
                      {"type": "Button", "name": "Home", "rect": {"x": 60, "y": 10, "width": 40, "height": 20}}]}
    monkeypatch.setattr(see, "_keep", lambda picture: None)
    answers = iter(['{"mark": 9, "open_url": null, "done": false, "why": "x"}',
                    '{"mark": null, "open_url": "https://mail.google.com", "done": false, "why": "gmail"}',
                    '{"mark": null, "open_url": null, "done": true, "why": "there"}'])
    monkeypatch.setattr(see, "ask_vision", lambda *a, **k: next(answers))
    assert "error" in navigator.decide(view, "export", [], [], "Word")  # 9 was never drawn
    assert navigator.decide(view, "gmail settings", [], [], "a page")["open_url"] == "https://mail.google.com"
    assert navigator.decide(view, "export", [], ["clicked File"], "Word")["done"] is True


def test_captions_dont_restart_twice_and_retry_restarts(monkeypatch):
    from vyrse import captions, turn

    sent = []
    monkeypatch.setattr("tools.desktop_ui.emit", lambda event, payload: sent.append(payload) or True, raising=False)
    captions._running, captions._running_to = False, ""
    turn.set_said("translate this video")
    assert json.loads(captions.handle({"action": "start", "to": "en"}))["ok"]
    assert json.loads(captions.handle({"action": "start", "to": "en"}))["note"].startswith("Captions are already on")
    assert [p["op"] for p in sent] == ["start"]  # the model asking again doesn't restart the capture
    turn.set_said("it is not, try again")
    out = captions.pre_llm_call(platform="vyrse", user_message="it is not try again", session_id="s1")
    assert "restarted" in out["context"] and [p["op"] for p in sent] == ["start", "stop", "start"]
    assert "restarted" in captions.transform_llm_output("whatever", session_id="s1", platform="vyrse")
    captions._running, captions._running_to = False, ""


def test_caption_script_check():
    from vyrse.captions import text_matches

    assert text_matches("നാളെ രാവിലെ ഞങ്ങൾ", "ml") and not text_matches("Vamos al mercado", "ml")
    assert text_matches("Vamos al mercado", "es")  # Latin script: can't tell, so no objection


def test_esc_stops_a_do_run_before_the_next_click(monkeypatch):
    """'Esc takes the controls back': once cancel() lands, the loop never clicks again."""
    from vyrse import navigator

    clicks = []
    steps = iter([{"label": "File", "item": {}}, {"label": "Export", "item": {}}, {"label": "PDF", "item": {}}])
    monkeypatch.setattr(navigator, "_step", lambda *a, **k: next(steps))
    monkeypatch.setattr(navigator, "_clear", lambda: None)
    monkeypatch.setattr(navigator.time, "sleep", lambda s: None)

    def click(item, label, *a, **k):
        clicks.append(label)
        navigator.cancel()  # Esc pressed while the first click lands

    monkeypatch.setattr(navigator, "_click", click)
    me = navigator._run_id
    out = navigator._walk("export as pdf", "do", {}, "Word", {"source": None}, me)
    assert clicks == ["File"]
    assert out["ok"] is False and out["stopped"] is True
    assert not navigator.active.is_set()
