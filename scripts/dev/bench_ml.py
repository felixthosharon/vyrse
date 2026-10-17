import os, sys, time
sys.path.insert(0, os.getcwd())
import hermes_bootstrap  # noqa
sys.path.insert(0, r"C:\dev\VYRSE\hermes-plugin")
from faster_whisper import WhisperModel, decode_audio
from vyrse.captions import translate_online
D = sys.argv[1]
truth = {"ml1": "Tomorrow morning we're going to the market, do you want to come too? You get good fish and vegetables there.",
         "ml2": "The story of this film is very interesting, but I felt the ending dragged on a bit."}
for name, kw in [(n, {}) for n in (sys.argv[2:] or ["small", "adalat-ai/ct2-whisper-medium-ml-rmft"])]:
    t = time.time()
    m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=6)
    print(f"== {name} (load {time.time()-t:.1f}s)")
    for clip in ("ml1", "ml2"):
        audio = decode_audio(os.path.join(D, clip + ".mp3"), sampling_rate=16000)
        t = time.time()
        segs, info = m.transcribe(audio, language="ml", beam_size=1, vad_filter=True, condition_on_previous_text=False)
        text = " ".join(s.text.strip() for s in segs)
        dt = time.time() - t
        print(f"  {clip} ({len(audio)/16000:.1f}s audio, {dt:.1f}s): {text}")
        print(f"     -> {translate_online(text, 'en', 'ml')}")
        print(f"     truth: {truth[clip]}")
