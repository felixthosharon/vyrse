# Third-party notices

VYRSE is a desktop and phone interface for **Hermes Agent**; Hermes is installed separately and is not
bundled. VYRSE includes or uses the following open-source work.

| Component | Where | License |
|---|---|---|
| [Hermes Agent](https://github.com/NousResearch/hermes-agent), Copyright (c) 2025 Nous Research | `app/src/services/hermes/vendor/` (the typed JSON-RPC client, copied unchanged); `hermes-patches/` (small patches to a local Hermes install) | MIT |
| [Heed](https://pypi.org/project/heed-wakeword/) wake-word trainer | downloaded by VYRSE's in-app training; `hermes-plugin/vyrse/wake/heed_numpy.py` and `app/src/lib/voice/heed.ts` reimplement its detector | Apache-2.0 |
| [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) voice model and [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | downloaded by `scripts/setup.ps1` | Apache-2.0 / MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (speech recognition, inside Hermes) | via Hermes | MIT |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) (local models, managed by Hermes) | via Hermes | MIT |
| [Electron](https://www.electronjs.org/), [React](https://react.dev/), [Capacitor](https://capacitorjs.com/), [Tailwind CSS](https://tailwindcss.com/), [lucide](https://lucide.dev/) | app and desktop shell | MIT |
| Space Grotesk, IBM Plex Mono fonts | `app/public/fonts/` | SIL Open Font License 1.1 |

The MIT license text for Hermes Agent applies to the files in `app/src/services/hermes/vendor/`:

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

The wake-word model in `assets/voice/wake/` was trained by this project on synthetic Kokoro voices only.
