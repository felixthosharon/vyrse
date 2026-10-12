<p align="center"><img src="assets/brand/vyrse-icon-256.png" width="128" height="128" alt="VYRSE logo"></p>

# VYRSE

**A voice-first AI assistant that lives on your own PC.** Say "VYRSE" and talk: it answers out loud, runs
your PC, works from your Android phone (and can operate it), and even takes questions from an Amazon Echo.
The AI runs locally on your GPU through [Hermes Agent](https://github.com/NousResearch/hermes-agent):
your conversations, memory and voice never leave your machine unless you choose an online model.

> VYRSE is the interface. Hermes Agent is the brain (models, tools, memory, skills, approvals). VYRSE
> doesn't reimplement any of that; it's the window, the voice, the phone app and the extras.

## What it does
- **Talk to it.** Wake word "VYRSE" (works for most voices; *Settings → Voice → Teach it your voice* makes it
  yours in about a minute), tap-to-talk, a push-to-talk shortcut, and replies spoken by a natural local voice.
- **Runs your PC.** Opens apps and types into them, finds files instantly, controls music, volume and
  brightness, reads what's on screen, browses the web, sets reminders and routines, gives a daily briefing.
- **Your phone, too.** The Android app is the same VYRSE (orb, glass, chat, voice) using your PC's AI over your
  home Wi-Fi. Your PC can ring the phone, read its notifications, use the flashlight, and (if you allow it)
  fully operate it: tap, type, open apps.
- **Echo / Alexa (optional).** "Alexa, ask my PC..." sends the question to VYRSE; VYRSE can make the Echo speak
  or run Alexa commands.
- **Talk styles.** Normal, Vibe, Fam, Chill, Hype, Focus, Pro and Savage (it roasts you, then still does the job).
- **Liquid-glass interface** with a live animated presence, workspace panel for charts and tables, settings
  search, light and dark themes.

## Requirements
- **Windows 10/11** (64-bit).
- **For local AI:** an NVIDIA GPU with 8 GB+ of memory is recommended (6 GB works with smaller models). Without
  one, use an online model through Hermes, or a small model on the CPU (slow).
- 16 GB RAM, ~15 GB free disk (a model is 5-8 GB).
- **Android 8+** for the phone app (optional).

## Install
1. **Install Hermes Agent** (the AI engine): follow https://github.com/NousResearch/hermes-agent. It installs
   to `%LOCALAPPDATA%\hermes` and brings its own Python and llama.cpp.
2. **Get VYRSE:** download the latest release (installer + `VYRSE.apk`) from the Releases page, or clone this
   repo to build it yourself (below).
3. **Set it up:** in the VYRSE folder, run
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
   ```
   It links the VYRSE plugin into Hermes, installs the voice libraries, downloads and verifies the Kokoro
   voice model, installs the wake word and VYRSE's skills, and sets the Hermes options VYRSE needs. Safe to run
   again any time; `-Check` only reports what's missing.
4. **Add an AI model**, either way:
   - run `hermes model` and pick a local model (Hermes downloads it), or
   - drop a `.gguf` file into the `models` folder (see `models/README.md` for what fits your GPU).
5. **Start VYRSE.** On first run it asks your name. Then say "VYRSE".

### Phone app
1. Install `VYRSE.apk` on your phone (allow installing from your browser/files app).
2. On the PC: *Settings → Phone* → turn on phone access → **Allow** (lets your home Wi-Fi reach VYRSE) →
   **Pair a phone**.
3. In the app, enter the PC address and code shown. Optional: *Settings → Phone* on the phone for
   "Let my PC reach this phone", notification access and full control.

### Echo / Alexa (optional)
*Settings → Echo / Alexa* on the PC walks you through it: sign in to Amazon for "VYRSE → Echo", and for
"Echo → VYRSE" create a free Alexa custom skill and a free ngrok tunnel; VYRSE gives you the interaction model
and endpoint to paste.

## Build from source
```powershell
cd app;     npm install; npm run build            # the UI
cd desktop; npm install; npm run pack             # the desktop app -> desktop\release\win-unpacked\VYRSE.exe
                                                   # (npm run dist makes an installer)
cd app;     npm run build:phone; npx cap sync android
cd app\android; .\gradlew.bat assembleRelease     # the phone app (needs JDK 21 + Android SDK)
```
Tests: `npm test` in `app/` and `desktop/`; `pytest hermes-plugin/vyrse/tests` with the Hermes Python.

## How it fits together
```
VYRSE desktop (Electron)                         Hermes Agent (Python, on this PC)
├─ desktop/  starts and supervises Hermes ──────► agent loop · tools · approvals · skills · memory
│            phone bridge (home Wi-Fi only)        sessions · faster-whisper speech recognition
│            Echo gateway (optional, via ngrok)    managed llama.cpp ─► your local model (GPU)
└─ app/      the UI (React) ◄── WebSocket ───────► vyrse plugin: UI control, Kokoro voice, wake word,
             also built as the Android app           PC/phone/Echo tools, briefing, reminders, files
```

| Path | What |
|---|---|
| `app/` | The interface (Vite + React), and the Android app (`app/android`, Capacitor). |
| `desktop/` | Electron shell: Hermes lifecycle, secure windows, phone bridge, Echo gateway. |
| `hermes-plugin/vyrse/` | The Hermes plugin (tools, voice, wake word, REST routes); `hermes-plugin/skills/` VYRSE's skills. |
| `hermes-patches/` | Small patches VYRSE applies to the local Hermes install (see `docs/hermes-patches.md`). |
| `scripts/` | `setup.ps1`, wake-word training and export tools. |
| `models/` | Put your `.gguf` models here. |

## Privacy and security
Everything runs on your PC. The phone connects over your home Wi-Fi only, with a per-phone key; the Echo
gateway (off by default) accepts only verified Amazon requests for your own skill. Risky actions ask first.
Details: [SECURITY.md](SECURITY.md).

## Credits
Built on [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research (MIT). Voice by
[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M); wake word trained with [Heed](https://pypi.org/project/heed-wakeword/).
See [NOTICE.md](NOTICE.md).

## License
MIT, see [LICENSE](LICENSE).
