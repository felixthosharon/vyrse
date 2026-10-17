"""Dev harness: a Word-online-like page (the whole app inside a cross-origin iframe, a ribbon of plain divs that
expose no controls) driven through the VYRSE extension in a THROWAWAY Chrome profile. Checks reading across frames,
clicking by looking at the screenshot, refs inside the frame, and that a ring goes away when the user clicks it.
Run from the hermes-agent folder: venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_chrome_frames.py
"""
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa: F401

sys.path.insert(0, r"C:\dev\VYRSE\hermes-plugin")
from hermes_cli.config import load_config
from hermes_cli.local_runtime.bootstrap import ensure_local_runtime
from vyrse import chrome

FRAME = b"""<!doctype html><html><head><meta charset=utf-8><style>
body{margin:0;font:15px 'Segoe UI',system-ui} .ribbon{display:flex;gap:4px;background:#185abd;padding:8px 14px}
.tab{color:#fff;padding:7px 14px;border-radius:4px;cursor:default} .tab:hover{background:#2b6ad0}
.menu{display:none;position:absolute;top:44px;left:14px;width:230px;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:6px 0}
.menu div{padding:9px 16px} .doc{margin:30px auto;width:620px;min-height:420px;background:#fff;box-shadow:0 1px 6px #0003;padding:40px}
.share{position:absolute;right:16px;top:6px;width:34px;height:30px;border:0;background:#fff;border-radius:4px}
</style></head><body style="background:#f3f2f1">
<div class=ribbon><div class=tab id=file>File</div><div class=tab id=home>Home</div><div class=tab>Insert</div><div class=tab>Layout</div><div class=tab>View</div></div>
<button class=share aria-label="Share" onclick="out('shared')"><svg viewBox="0 0 24 24" width=18><path d="M4 12v7h16v-7M12 3v12M7 8l5-5 5 5" stroke="#185abd" stroke-width=2 fill=none /></svg></button>
<div class=menu id=menu><div id=info>Info</div><div id=saveas>Save a copy</div><div id=export>Export to PDF</div><div>Print</div></div>
<div class=doc><h2>SIT379 Report</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p><p id=o>status: idle</p></div>
<script>function out(t){document.getElementById('o').textContent='status: '+t}
document.getElementById('file').addEventListener('click',()=>{document.getElementById('menu').style.display='block';out('file menu open')})
document.getElementById('export').addEventListener('click',()=>{document.getElementById('menu').style.display='none';out('exported pdf')})
document.getElementById('home').addEventListener('click',()=>out('home'))</script></body></html>"""


def top_page(frame_url):
    return (f"""<!doctype html><html><head><meta charset=utf-8><title>Report.docx - Word</title>
<style>html,body{{margin:0;height:100%}} iframe{{border:0;width:100%;height:100%;display:block}}</style></head>
<body><iframe src="{frame_url}"></iframe></body></html>""").encode()


def serve(body_for):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body_for())

        def log_message(self, *a):
            pass
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def cdp_page(port, title_part):
    from websockets.sync.client import connect

    for t in json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list")):
        if t.get("type") == "page" and title_part in (t.get("title") or ""):
            return connect(t["webSocketDebuggerUrl"], max_size=None)
    raise RuntimeError("page target not found")


def cdp(ws, method, params=None, _id=[0]):
    _id[0] += 1
    ws.send(json.dumps({"id": _id[0], "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv(timeout=20))
        if msg.get("id") == _id[0]:
            return msg.get("result") or msg


def frame_status():
    text = chrome.call("snapshot", {"text": True})["text"]
    return text[text.find("status:"):][:30]


def step(label, params):
    t = time.time()
    out = json.loads(chrome.handle(params))
    keep = {k: v for k, v in out.items() if k in ("ok", "clicked", "shown", "error", "note", "controls")}
    print(f"\n== {label} ({time.time() - t:.1f}s) {json.dumps(keep, ensure_ascii=False)[:600]}")
    return out


import logging
logging.basicConfig(level=logging.WARNING, format="   [log] %(message)s")
logging.getLogger("vyrse").setLevel(logging.INFO)
for name in ("hermes_plugins.vyrse", "vyrse.see", "vyrse.chrome"):
    logging.getLogger(name).setLevel(logging.INFO)
SERVE_ONLY = "--serve-only" in sys.argv  # just the page + Chrome + extension, for a live VYRSE backend to drive
ext = chrome.install_extension()
if not SERVE_ONLY:
    ensure_local_runtime(load_config())
    assert chrome.start_server(), "bridge port busy (close VYRSE for this test)"
fport = serve(lambda: FRAME)
tport = serve(lambda: top_page(f"http://localhost:{fport}/frame"))  # another origin, like word-edit.officeapps
profile = tempfile.mkdtemp(prefix="vyrse-chrome-test-")
proc = subprocess.Popen([r"C:\Program Files\Google\Chrome\Application\chrome.exe", f"--user-data-dir={profile}",
                         "--remote-debugging-port=9333", "--enable-unsafe-extension-debugging", "--no-first-run",
                         "--no-default-browser-check", "--window-size=1300,900", "about:blank"])
try:
    from websockets.sync.client import connect

    for _ in range(50):
        try:
            info = json.load(urllib.request.urlopen("http://127.0.0.1:9333/json/version", timeout=2))
            break
        except Exception:
            time.sleep(0.2)
    with connect(info["webSocketDebuggerUrl"], max_size=None) as b:
        b.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked", "params": {"path": str(ext)}}))
        print("loadUnpacked:", b.recv(timeout=20))
    if SERVE_ONLY:
        with connect(info["webSocketDebuggerUrl"], max_size=None) as b:
            b.send(json.dumps({"id": 2, "method": "Target.createTarget", "params": {"url": f"http://127.0.0.1:{tport}/"}}))
            print("page opened:", b.recv(timeout=20), flush=True)
        time.sleep(float(sys.argv[-1]) if sys.argv[-1].replace(".", "").isdigit() else 240)
        raise SystemExit
    for _ in range(80):
        if chrome.connected():
            break
        time.sleep(0.5)
    print("extension connected:", chrome.connected())
    step("open", {"action": "open", "url": f"http://127.0.0.1:{tport}/"})
    r = step("read", {"action": "read"})
    print("   text has frame content:", "SIT379 Report" in (r.get("text") or ""))
    step("click File", {"action": "click", "target": "File"})
    print("   page:", frame_status())
    step("click Export to PDF", {"action": "click", "target": "Export to PDF"})
    print("   page:", frame_status())
    step("click the share icon", {"action": "click", "target": "the share icon"})
    print("   page:", frame_status())
    step("point at Home", {"action": "point", "target": "Home", "caption": "Click here"})
    page = cdp_page(9333, "Report.docx")
    ring = cdp(page, "Runtime.evaluate", {"expression": "JSON.stringify(document.getElementById('__vyrse_hl')?.getBoundingClientRect())", "returnByValue": True})
    if "value" not in ring.get("result", {}):
        raise SystemExit("no ring on the page")
    rect = json.loads(ring["result"]["value"])
    print("   ring at", {k: round(rect[k]) for k in ("x", "y", "width", "height")})
    chrome.ring_clicked.clear()
    x, y = rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2
    for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
        cdp(page, "Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})
    print("   ring_clicked event:", chrome.ring_clicked.wait(5))
    time.sleep(0.5)
    gone = cdp(page, "Runtime.evaluate", {"expression": "!document.getElementById('__vyrse_hl')", "returnByValue": True})
    print("   ring gone after click:", gone["result"]["value"], "| page:", frame_status())
    step("click a rocket", {"action": "click", "target": "the rocket launch button"})
finally:
    time.sleep(1)
    proc.terminate()
    time.sleep(1.5)
    shutil.rmtree(profile, ignore_errors=True)
