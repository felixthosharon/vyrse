"""Delete the sessions a smoke battery made (VYRSE_SMOKE=battery writes {"stored": id} lines to its output), and
their workspace boards, after the run has ended. Hermes may write a session row again after the battery deleted
it (titles are generated in the background), so this runs once the backend is gone.
Run from hermes-agent: venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/battery_cleanup.py <battery.jsonl>...
"""
import json
import os
import subprocess
import sys
from pathlib import Path

home = Path(os.environ.get("HERMES_HOME") or Path(os.environ["LOCALAPPDATA"]) / "hermes")
ids = []
for out in sys.argv[1:]:
    for line in open(out, encoding="utf-8"):
        row = json.loads(line)
        ids += [row[k] for k in ("stored", "undeleted") if row.get(k)]
done = 0
for sid in dict.fromkeys(ids):
    r = subprocess.run([sys.executable, "-m", "hermes_cli.main", "sessions", "delete", sid, "--yes"], capture_output=True, text=True)
    done += r.returncode == 0
    (home / "vyrse" / "workspace" / f"{sid}.json").unlink(missing_ok=True)
print(f"deleted {done} of {len(dict.fromkeys(ids))} battery sessions")
