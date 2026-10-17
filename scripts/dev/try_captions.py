"""Dev harness: captions.chunk on audio files (as the app would send them). Run from hermes-agent:
venv/Scripts/python.exe C:/dev/VYRSE/scripts/dev/try_captions.py <source-hint or -> <file>..."""
import os, sys, time
sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa
sys.path.insert(0, r"C:\dev\VYRSE\hermes-plugin")
import numpy as np
from faster_whisper import decode_audio
from vyrse import captions
captions._source = "" if sys.argv[1] == "-" else sys.argv[1]
captions.warm()
for f in sys.argv[2:]:
    pcm = (decode_audio(f, sampling_rate=16000) * 32767).astype(np.int16).tobytes()
    t = time.time()
    out = captions.chunk(pcm, "en", True, "test-" + sys.argv[1])
    print(f"{os.path.basename(f)} ({time.time() - t:.1f}s): {out}")
