"""Dev harness: vyrse_point action=do / guide on a Word-for-the-web-like page (app inside a cross-origin frame,
ribbon of plain divs: File -> Export -> Download as PDF -> Download), in HEADLESS Chrome with the VYRSE extension
(nothing appears on screen). The steps come from the real web lookup, so this checks lookup + finding + clicking.
Run from the hermes-agent folder: venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_onscreen.py
"""
import http.server
import json
import logging
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
from vyrse import chrome, onscreen

FRAME = b"""<!doctype html><html><head><meta charset=utf-8><style>
body{margin:0;font:15px 'Segoe UI',system-ui;background:#f3f2f1} .ribbon{display:flex;gap:4px;background:#185abd;padding:8px 14px}
.tab{color:#fff;padding:7px 14px;border-radius:4px} .pane{display:none;position:absolute;inset:44px auto 0 0;width:260px;background:#0f3d8a;color:#fff;padding:12px 0}
.pane div{padding:11px 22px} .sub{display:none;position:absolute;left:280px;top:90px;width:340px;background:#fff;box-shadow:0 6px 24px #0004}
.sub div{padding:14px 18px;border-bottom:1px solid #eee} .dlg{display:none;position:absolute;left:35%;top:35%;width:360px;background:#fff;box-shadow:0 10px 40px #0005;padding:22px}
.btn{display:inline-block;margin-top:16px;padding:8px 18px;background:#185abd;color:#fff;border-radius:4px}
.doc{margin:30px auto;width:620px;min-height:420px;background:#fff;box-shadow:0 1px 6px #0003;padding:40px}
</style></head><body>
<div class=ribbon><div class=tab id=file>File</div><div class=tab>Home</div><div class=tab>Insert</div><div class=tab>Layout</div><div class=tab>References</div><div class=tab>View</div></div>
<div class=pane id=pane><div>Home</div><div>New</div><div>Open</div><div>Info</div><div>Save a Copy</div><div>Print</div><div>Share</div><div id=export>Export</div></div>
<div class=sub id=sub><div id=dlpdf><b>Download as PDF</b><br><small>Export document as a PDF</small></div><div><b>Download as ODT</b><br><small>OpenDocument text</small></div></div>
<div class=dlg id=dlg>Your PDF is ready.<br><span class=btn id=download>Download</span></div>
<div class=doc><h2>SIT379 Report</h2><p>Lorem ipsum dolor sit amet.</p><p id=o>status: idle</p></div>
<script>const $=id=>document.getElementById(id), out=t=>$('o').textContent='status: '+t
$('file').onclick=()=>{$('pane').style.display='block';out('file')}
$('export').onclick=()=>{$('sub').style.display='block';out('export')}
$('dlpdf').onclick=()=>{$('pane').style.display=$('sub').style.display='none';$('dlg').style.display='block';out('dialog')}
$('download').onclick=()=>{$('dlg').style.display='none';out('downloaded pdf')}</script></body></html>"""


def serve(body):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body())

        def log_message(self, *a):
            pass
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def status():
    text = chrome.call("snapshot", {"text": True})["text"]
    return text[text.find("status:"):][:30]


logging.basicConfig(level=logging.WARNING, format="   [log] %(message)s")
for name in ("vyrse", "vyrse.see", "vyrse.chrome", "vyrse.onscreen", "vyrse.lookup"):
    logging.getLogger(name).setLevel(logging.INFO)
ensure_local_runtime(load_config())
# its own port and extension copy, so a running VYRSE (and the user's installed extension) is left alone
from pathlib import Path
chrome.PORT = 18493
_test_ext = Path(tempfile.mkdtemp(prefix="vyrse-ext-test-"))
chrome.extension_dir = lambda: _test_ext
ext = chrome.install_extension()
assert chrome.start_server(), "bridge port busy (close VYRSE for this test)"
fport = serve(lambda: FRAME)
tport = serve(lambda: f"""<!doctype html><html><head><meta charset=utf-8><title>SIT379-9.1P.docx</title>
<style>html,body{{margin:0;height:100%}} iframe{{border:0;width:100%;height:100%;display:block}}</style></head>
<body><iframe src="http://localhost:{fport}/frame"></iframe></body></html>""".encode())
profile = tempfile.mkdtemp(prefix="vyrse-chrome-test-")
proc = subprocess.Popen([r"C:\Program Files\Google\Chrome\Application\chrome.exe", "--headless=new", f"--user-data-dir={profile}",
                         "--remote-debugging-port=9334", "--enable-unsafe-extension-debugging", "--no-first-run",
                         "--window-size=1300,900", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    from websockets.sync.client import connect

    for _ in range(60):
        try:
            info = json.load(urllib.request.urlopen("http://127.0.0.1:9334/json/version", timeout=2))
            break
        except Exception:
            time.sleep(0.25)
    with connect(info["webSocketDebuggerUrl"], max_size=None) as b:
        b.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked", "params": {"path": str(ext)}}))
        print("loadUnpacked:", b.recv(timeout=20))
    for _ in range(80):
        if chrome.connected():
            break
        time.sleep(0.5)
    print("extension connected:", chrome.connected())
    # the docx url makes it read as Word for the web, like word.cloud.microsoft does
    print(json.loads(chrome.handle({"action": "open", "url": f"http://127.0.0.1:{tport}/open/onedrive/SIT379-9.1P.docx"})).get("title"))
    print("context:", onscreen.screen_context("Word"))
    mode = sys.argv[1] if len(sys.argv) > 1 else "do"
    if "--no-signal" in sys.argv:  # the ring-click signal never arrives: the walk must notice the next step itself
        class Deaf(threading.Event):
            def set(self):
                pass
        chrome.ring_clicked = Deaf()
    t = time.time()
    if mode == "do":
        out = onscreen.do("export as PDF", "Word")
        print(f"\n== do ({time.time() - t:.1f}s):", json.dumps(out, ensure_ascii=False, indent=1)[:1500])
        print("page:", status())
    else:
        out = onscreen.guide("export as PDF", "Word")
        print(f"\n== guide ({time.time() - t:.1f}s):", json.dumps(out, ensure_ascii=False)[:900])
        # play the user: click whatever is ringed, four times
        from websockets.sync.client import connect as c2
        for t_ in json.load(urllib.request.urlopen("http://127.0.0.1:9334/json/list")):
            if t_.get("type") == "page" and "SIT379" in (t_.get("title") or ""):
                page = c2(t_["webSocketDebuggerUrl"], max_size=None)
        n = [0]

        def cdp(method, params=None):
            n[0] += 1
            page.send(json.dumps({"id": n[0], "method": method, "params": params or {}}))
            while True:
                m = json.loads(page.recv(timeout=20))
                if m.get("id") == n[0]:
                    return m.get("result") or {}
        for k in range(5):
            r = {}
            for _ in range(40):
                r = cdp("Runtime.evaluate", {"expression": "JSON.stringify(document.getElementById('__vyrse_hl')?.getBoundingClientRect())", "returnByValue": True})
                if r.get("result", {}).get("value"):
                    break
                time.sleep(0.5)
            if not r.get("result", {}).get("value"):
                print("   no ring now"); break
            rect = json.loads(r["result"]["value"])
            x, y = rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2
            for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
                cdp("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})
            time.sleep(0.6)
            print(f"   user clicked ring {k + 1} at ({x:.0f},{y:.0f}) -> page {status()}")
            time.sleep(2.5)
finally:
    proc.terminate()
    time.sleep(1.5)
    shutil.rmtree(profile, ignore_errors=True)
