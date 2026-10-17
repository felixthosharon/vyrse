"""Dev harness: the VYRSE Chrome extension end to end, in a THROWAWAY Chrome profile (never the user's).

Starts the plugin's bridge, launches Chrome with a temp profile, loads the unpacked extension over CDP, serves a
test page full of unlabeled icon buttons, then drives it with vyrse_chrome the way the model would.
Run from the hermes-agent folder: venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_chrome.py
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

PAGE = b"""<!doctype html><html><head><meta charset=utf-8><title>VYRSE test page</title>
<style>body{font:16px system-ui;margin:40px} .bar{display:flex;gap:14px;margin:20px 0} button{width:48px;height:48px;
border:1px solid #ccc;border-radius:10px;background:#fff;cursor:pointer} svg{width:26px;height:26px}</style></head>
<body><h1>Account</h1><p>Notifications are off. Settings are saved automatically. Delete old drafts weekly.</p>
<div class=bar>
 <button onclick="hit('home')"><svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z" fill="#333"/></svg></button>
 <button onclick="hit('bell')"><svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 002-2h-4a2 2 0 002 2zm6-6V11a6 6 0 00-5-5.9V4a1 1 0 00-2 0v1.1A6 6 0 006 11v5l-2 2v1h16v-1z" fill="#333"/></svg></button>
 <button onclick="hit('gear')"><svg viewBox="0 0 24 24"><circle cx=12 cy=12 r=3.2 fill=none stroke="#333" stroke-width=2.4 /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="#333" stroke-width=2.4 /></svg></button>
 <button onclick="hit('trash')"><svg viewBox="0 0 24 24"><path d="M6 7h12l-1 14H7zM4 5h16M9 5V3h6v2" fill=none stroke="#333" stroke-width=2 /></svg></button>
</div>
<input id=q placeholder="Search your mail" style="width:320px;padding:10px">
<p id=out>nothing clicked</p>
<script>function hit(n){document.getElementById('out').textContent='clicked: '+n}
document.getElementById('q').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('out').textContent='searched: '+e.target.value})</script>
</body></html>"""


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *a):
        pass


def cdp_load_extension(port: int, path: str) -> None:
    from websockets.sync.client import connect

    for _ in range(50):
        try:
            info = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2))
            break
        except Exception:
            time.sleep(0.2)
    with connect(info["webSocketDebuggerUrl"], max_size=None) as ws:
        ws.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked", "params": {"path": path}}))
        print("loadUnpacked:", ws.recv(timeout=20))


def step(label, params):
    t = time.time()
    out = json.loads(chrome.handle(params))
    short = {k: (v if len(str(v)) < 300 else str(v)[:300] + "…") for k, v in out.items()}
    print(f"\n== {label} ({time.time() - t:.1f}s)\n{json.dumps(short, ensure_ascii=False, indent=1)}")
    return out


ensure_local_runtime(load_config())
ext = chrome.install_extension()
assert chrome.start_server(), "bridge port busy (is VYRSE running? close it for this test)"
srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Page)
threading.Thread(target=srv.serve_forever, daemon=True).start()
page_url = f"http://127.0.0.1:{srv.server_address[1]}/"

profile = tempfile.mkdtemp(prefix="vyrse-chrome-test-")
exe = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
proc = subprocess.Popen([exe, f"--user-data-dir={profile}", "--remote-debugging-port=9333", "--enable-unsafe-extension-debugging",
                         "--no-first-run", "--no-default-browser-check", "--window-size=1200,900", "about:blank"])
try:
    cdp_load_extension(9333, str(ext))
    for _ in range(80):
        if chrome.connected():
            break
        time.sleep(0.5)
    print("extension connected:", chrome.connected())
    step("open the test page", {"action": "open", "url": page_url})
    if os.environ.get("ONLY_OPEN"):
        step("open again", {"action": "open", "url": page_url})
        step("go example.com", {"action": "go", "url": "https://example.com"})
        t = time.time(); print(chrome.call("tabs")); print("tabs", time.time() - t)
        raise SystemExit
    step("read", {"action": "read"})
    step("click 'the bell'", {"action": "click", "target": "the bell"})
    print("page says:", chrome.call("snapshot", {"text": True})["text"][-40:])
    step("look", {"action": "look", "question": "Which icons are in the row of buttons, left to right?"})
    step("click 'settings'", {"action": "click", "target": "settings"})
    print("page says:", chrome.call("snapshot", {"text": True})["text"][-40:])
    step("click 'delete'", {"action": "click", "target": "delete"})
    print("page says:", chrome.call("snapshot", {"text": True})["text"][-40:])
    step("click 'the rocket'", {"action": "click", "target": "the rocket"})
    step("type in search", {"action": "type", "target": "search box", "text": "invoice from march", "submit": True})
    print("page says:", chrome.call("snapshot", {"text": True})["text"][-40:])
    step("point at home", {"action": "point", "target": "home icon", "caption": "Back to the start"})
    step("tabs", {"action": "tabs"})
finally:
    time.sleep(2)
    proc.terminate()
    time.sleep(1.5)
    shutil.rmtree(profile, ignore_errors=True)
