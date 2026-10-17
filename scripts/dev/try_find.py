"""Dev harness: run the VYRSE plugin's find-by-looking against a live window.
Usage (from the hermes-agent folder): venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_find.py <window> <request>..."""
import os
import sys
import time

sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa: F401  (Hermes' own dependency setup)

sys.path.insert(0, r"C:\dev\VYRSE\hermes-plugin")
from hermes_cli.config import load_config
from hermes_cli.local_runtime.bootstrap import ensure_local_runtime
from vyrse.point import find

ensure_local_runtime(load_config())
window = sys.argv[1]
for request in sys.argv[2:]:
    t = time.time()
    hit = find(request, window)
    print(f"{request!r}: {hit.get('ok')} {hit.get('name')!r} {hit.get('type')} {hit.get('source')} {hit.get('rect')} "
          f"why={hit.get('why')!r} err={hit.get('error')!r} {time.time() - t:.1f}s")
