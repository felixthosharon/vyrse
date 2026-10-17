"""Dev harness: the captions engine loaded the way the dashboard route loads it (a standalone copy of captions.py)."""
import importlib.util, os, sys, time, traceback
sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa
import numpy as np
from faster_whisper import decode_audio
spec = importlib.util.spec_from_file_location("vyrse_plugin_captions", r"C:\dev\VYRSE\hermes-plugin\vyrse\captions.py")
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
mod.warm()
for f in sys.argv[1:]:
    pcm = (decode_audio(f, sampling_rate=16000) * 32767).astype(np.int16).tobytes()
    t = time.time()
    try:
        print(os.path.basename(f), f"{time.time()-t:.1f}s", mod.chunk(pcm, "en", True, "route-test"))
    except Exception:
        traceback.print_exc()
