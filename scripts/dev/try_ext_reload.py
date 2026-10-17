"""Dev harness: does an out-of-date VYRSE extension reload itself (and come back as the new version)?
Loads the PREVIOUS commit's extension in headless Chrome, swaps the files for the current ones, lets the bridge
ask it to reload. Run from hermes-agent: venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_ext_reload.py <old-commit>"""
import json, logging, os, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa: F401
sys.path.insert(0, r"C:\dev\VYRSE\hermes-plugin")
from vyrse import chrome

logging.basicConfig(level=logging.INFO, format="   [log] %(message)s")
old = sys.argv[1]
SAME = "--same" in sys.argv  # load the current files and only ask for a reload
ext = Path(tempfile.mkdtemp(prefix="vyrse-ext-reload-"))
for name in ("manifest.json", "background.js", "popup.html", "popup.js"):
    data = (Path(r"C:\dev\VYRSE\chrome-extension") / name).read_bytes() if SAME else subprocess.run(["git", "-C", r"C:\dev\VYRSE", "show", f"{old}:chrome-extension/{name}"], capture_output=True).stdout
    (ext / name).write_bytes(data)
shutil.copytree(r"C:\dev\VYRSE\chrome-extension\icons", ext / "icons")
chrome.PORT = 18494
(ext / "config.js").write_text(f"export const CONFIG = {{ port: {chrome.PORT}, token: {json.dumps(chrome.token())} }}\n")
chrome.extension_dir = lambda: ext
print("old version:", json.loads((ext / "manifest.json").read_text())["version"])
profile = tempfile.mkdtemp(prefix="vyrse-chrome-test-")
proc = subprocess.Popen([r"C:\Program Files\Google\Chrome\Application\chrome.exe", "--headless=new", f"--user-data-dir={profile}",
                         "--remote-debugging-port=9335", "--enable-unsafe-extension-debugging", "--no-first-run", "about:blank"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    from websockets.sync.client import connect
    for _ in range(60):
        try:
            info = json.load(urllib.request.urlopen("http://127.0.0.1:9335/json/version", timeout=2)); break
        except Exception:
            time.sleep(0.25)
    with connect(info["webSocketDebuggerUrl"], max_size=None) as b:
        b.send(json.dumps({"id": 1, "method": "Extensions.loadUnpacked", "params": {"path": str(ext)}}))
        print("loaded:", b.recv(timeout=20))
    # the new files land on disk (what VYRSE's install does), then the bridge starts and sees the old one connect
    for src in Path(r"C:\dev\VYRSE\chrome-extension").glob("*"):
        if src.is_file() and src.name != "config.js":
            shutil.copyfile(src, ext / src.name)
    if SAME:
        calls = [0]
        def fake():
            calls[0] += 1
            return "9.9.9" if calls[0] == 1 else "1.2.0"
        chrome._installed_version = fake
    print("installed version now:", chrome._installed_version() if not SAME else "(reload once)")
    chrome.start_server()
    for k in range(6):
        time.sleep(8)
        ts = json.load(urllib.request.urlopen("http://127.0.0.1:9335/json/list"))
        print(f"t+{8*(k+1)}s targets:", [(t["type"], t["url"][:60]) for t in ts if "extension" in t["url"] or t["type"] != "page"])
finally:
    proc.terminate(); time.sleep(1); shutil.rmtree(profile, ignore_errors=True)
