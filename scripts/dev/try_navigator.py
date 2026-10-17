"""Dev harness: the navigator (vyrse_point guide/do, one look per step) on a Word-for-the-web-like page, in a real
Chrome window placed OFF the screen (nothing appears for the user), with the VYRSE extension on a test port.
guide: the "user" clicks whatever gets ringed (a browser click at that spot). do: VYRSE clicks by itself.
Run from hermes-agent: venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_navigator.py do|guide ["goal"]
"""
import http.server, json, logging, os, shutil, socketserver, subprocess, sys, tempfile, threading, time, urllib.request
from pathlib import Path

sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa: F401
sys.path.insert(0, r"C:\dev\VYRSE\hermes-plugin")
from hermes_cli.config import load_config
from hermes_cli.local_runtime.bootstrap import ensure_local_runtime
from vyrse import chrome, navigator
from vyrse.point import locate

sys.path.insert(0, r"C:\dev\VYRSE\scripts\dev")
from word_page import FRAME  # noqa: E402  (the Word-like test page)

logging.basicConfig(level=logging.WARNING, format="   [log] %(message)s")
for name in ("vyrse", "vyrse.navigator", "vyrse.see", "vyrse.chrome", "vyrse.lookup"):
    logging.getLogger(name).setLevel(logging.INFO)

mode = sys.argv[1] if len(sys.argv) > 1 else "do"
goal = sys.argv[2] if len(sys.argv) > 2 else "export this document as a PDF"
ensure_local_runtime(load_config())
chrome.PORT = 18493
_ext = Path(tempfile.mkdtemp(prefix="vyrse-ext-test-"))
chrome.extension_dir = lambda: _ext
ext = chrome.install_extension()
assert chrome.start_server()


def serve(body):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers(); self.wfile.write(body())
        def log_message(self, *a):
            pass
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


fport = serve(lambda: FRAME)
tport = serve(lambda: f"""<!doctype html><html><head><meta charset=utf-8><title>SIT379-TEST.docx</title>
<style>html,body{{margin:0;height:100%}} iframe{{border:0;width:100%;height:100%;display:block}}</style></head>
<body><iframe src="http://localhost:{fport}/frame"></iframe></body></html>""".encode())
profile = tempfile.mkdtemp(prefix="vyrse-chrome-test-")
proc = subprocess.Popen([r"C:\Program Files\Google\Chrome\Application\chrome.exe", f"--user-data-dir={profile}",
                         "--remote-debugging-port=9336", "--enable-unsafe-extension-debugging", "--no-first-run",
                         "--no-default-browser-check", "--window-position=-2600,60", "--window-size=1300,900", "about:blank"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    from websockets.sync.client import connect
    for _ in range(80):
        try:
            info = json.load(urllib.request.urlopen("http://127.0.0.1:9336/json/version", timeout=2)); break
        except Exception:
            time.sleep(0.25)
    with connect(info["webSocketDebuggerUrl"], max_size=None) as b:
        b.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked", "params": {"path": str(ext)}})); b.recv(timeout=20)
    for _ in range(80):
        if chrome.connected():
            break
        time.sleep(0.5)
    tab = json.loads(chrome.handle({"action": "open", "url": f"http://127.0.0.1:{tport}/open/onedrive/SIT379-TEST.docx"}))
    time.sleep(2)

    def status():
        t = chrome.call("snapshot", {"text": True})["text"]
        return t[t.find("status:"):][:30]

    # only this test window: never the user's own Chrome
    ctx = {"surface": "chrome", "app": "Word for the web", "title": "SIT379-TEST.docx", "tab": tab["tab"],
           "window": "SIT379-TEST", "proc": "SIT379-TEST"}
    if mode == "guide":
        rang = []
        real_ring = navigator._ring

        def fake_ring(item, label, caption, step):  # the "user" clicks what was ringed, a moment later
            rang.append(label)
            print(f"   ring {step}: {label!r} ({caption})")
            vp = locate("-", "SIT379-TEST", mode="list").get("viewport")
            r = item["rect"]
            x, y = r["x"] + r["width"] / 2 - vp["x"], r["y"] + r["height"] / 2 - vp["y"]

            def user():
                time.sleep(1.5)
                chrome.call("click", {"rect": {"x": x - 1, "y": y - 1, "width": 2, "height": 2}})
                print(f"   user clicked it -> {status()}")
            threading.Thread(target=user, daemon=True).start()
        navigator._ring = fake_ring
        navigator._tell = lambda text: print("   [VYRSE says]", text)
    t = time.time()
    out = navigator.start(goal, mode, ctx, private=False)
    print(f"== {mode} returned ({time.time() - t:.1f}s): {json.dumps(out, ensure_ascii=False)[:600]}")
    if mode == "guide":
        for _ in range(120):
            if not navigator.active.is_set():
                break
            time.sleep(1)
    print("page at the end:", status())
finally:
    proc.terminate(); time.sleep(1.5); shutil.rmtree(profile, ignore_errors=True)
