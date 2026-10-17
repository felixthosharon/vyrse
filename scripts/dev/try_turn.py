"""Dev harness: one real VYRSE turn against a separate `hermes serve` (works while the VYRSE app is open).
Prints each tool call and the reply. On-screen jobs run dry (VYRSE_ONSCREEN_DRY): nothing on the real screen is
clicked. Run from the hermes-agent folder: venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_turn.py "<prompt>"...
"""
import json
import os
import secrets
import subprocess
import sys
import threading
import time

from websockets.sync.client import connect

token = secrets.token_urlsafe(24)
env = {**os.environ, "HERMES_DASHBOARD_SESSION_TOKEN": token, "PYTHONUTF8": "1", "VYRSE_ONSCREEN_DRY": "1",
       "HERMES_PARENT_PID": str(os.getpid())}
proc = subprocess.Popen([sys.executable, "-m", "hermes_cli.main", "serve", "--host", "127.0.0.1", "--port", "0", "--isolated"],
                        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
port = None
deadline = time.time() + 120
while time.time() < deadline:
    line = proc.stdout.readline()
    if "HERMES_BACKEND_READY" in line:
        port = int(line.split("port=")[1].split()[0])
        break
if not port:
    proc.kill()
    raise SystemExit("backend didn't start")
threading.Thread(target=lambda: [None for _ in proc.stdout], daemon=True).start()

try:
    for prompt in sys.argv[1:]:
        ws = connect(f"ws://127.0.0.1:{port}/api/ws?token={token}", max_size=None, open_timeout=30)
        n = [0]

        def call(method, params):
            n[0] += 1
            rid = f"t{n[0]}"
            ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
            while True:
                msg = json.loads(ws.recv(timeout=120))
                if msg.get("id") == rid:
                    return msg.get("result")
        sid = call("session.create", {"source": "vyrse", "close_on_disconnect": True})["session_id"]
        print(f"\n######## {prompt}")
        call("prompt.submit", {"session_id": sid, "text": prompt})
        text = ""
        t = time.time()
        while time.time() - t < 400:
            for line in ws.recv(timeout=400).split("\n"):
                if not line.strip():
                    continue
                msg = json.loads(line)
                if msg.get("id") is not None and msg.get("method"):
                    ws.send(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "not handled"}}))
                    continue
                if msg.get("method") != "event":
                    continue
                kind, p = msg["params"].get("type"), msg["params"].get("payload") or {}
                if kind == "tool.start":
                    print("  tool:", p.get("name"), json.dumps(p.get("args") or p.get("arguments") or "", ensure_ascii=False)[:300])
                elif kind == "tool.complete":
                    print("   ->", json.dumps(p.get("result") or p.get("output") or "", ensure_ascii=False)[:400])
                elif kind == "message.delta":
                    text += p.get("text") or ""
                elif kind == "message.complete":
                    print("  reply:", (p.get("text") or text)[:500].replace("\n", " "))
                    t = 0
            if t == 0:
                break
        ws.close()
finally:
    proc.kill()
