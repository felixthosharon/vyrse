"""Dev harness: can the local vision model put a box on a control by itself (no element list)?
Captures a window with locate.ps1 (mode=list), asks for each request's box, and compares it with UI Automation's rect.
Run from the hermes-agent folder: venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_bbox.py <window> <label>...
"""
import os
import sys
import time

sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa: F401

sys.path.insert(0, r"C:\dev\VYRSE\hermes-plugin")
from pathlib import Path

from hermes_cli.config import load_config
from hermes_cli.local_runtime.bootstrap import ensure_local_runtime
from vyrse import see
from vyrse.point import locate

ensure_local_runtime(load_config())
window = sys.argv[1]
listing = locate("-", window, mode="list")
png = Path(listing["image"]).read_bytes()
area = listing["rect"]
by_name = {str(i.get("name") or ""): i["rect"] for i in listing["items"]}
for label in sys.argv[2:]:
    request = label.split("=")[0]
    truth = by_name.get(label.split("=")[-1])
    t = time.time()
    found = see.locate_pixels(png, request, where=f"the window '{listing['window']}'")
    got = None
    if found:
        got = {"x": found["x"] + area["x"], "y": found["y"] + area["y"], "width": found["width"], "height": found["height"]}
    hit = None
    if got and truth:
        cx, cy = got["x"] + got["width"] / 2, got["y"] + got["height"] / 2
        hit = truth["x"] - 6 <= cx <= truth["x"] + truth["width"] + 6 and truth["y"] - 6 <= cy <= truth["y"] + truth["height"] + 6
    print(f"{request!r}: got={got} truth={truth} centre_inside={hit} {time.time() - t:.1f}s")
