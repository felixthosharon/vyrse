"""Dev harness: vyrse_point action=how (steps looked up on the web). Run from the hermes-agent folder."""
import json
import os
import sys
import time

sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa: F401

sys.path.insert(0, r"C:\dev\VYRSE\hermes-plugin")
from hermes_cli.config import load_config
from hermes_cli.local_runtime.bootstrap import ensure_local_runtime
from vyrse.lookup import how_to

ensure_local_runtime(load_config())
for app, goal in [(a.split("|")[0], a.split("|")[1]) for a in sys.argv[1:]]:
    t = time.time()
    print(f"== {app}: {goal} ({0})")
    print(json.dumps(how_to(app, goal), ensure_ascii=False, indent=1))
    print(f"   {time.time() - t:.1f}s")
