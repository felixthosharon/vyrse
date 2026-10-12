# Testing VYRSE yourself

## Start it
Run `C:\dev\VYRSE\desktop\release\win-unpacked\VYRSE.exe` (the packaged app, nothing gets installed).
Before the first run, and after any `hermes update`, check Hermes is ready:
`powershell -ExecutionPolicy Bypass -File C:\dev\VYRSE\scripts\setup.ps1 -Check` → "Hermes is ready for VYRSE."

Startup takes ~10 s: the top bar says *connecting*, then *present*. In the background VYRSE pre-loads the
model (~10 s more); the first answer is slower if you ask during that time.

## Checklist
| # | Try | Expect |
|---|---|---|
| 1 | Type "What can you do on this PC?" | Streams an answer; your last conversation was resumed at startup |
| 2 | "List the files in my Downloads folder" | A *Terminal* or *Read file* chip, then the list |
| 3 | "Which windows are open on my screen?" | *Computer control* chip with your real windows |
| 4 | "Open Notepad and type hello" | Notepad opens and the text appears |
| 5 | "Open youtube.com and tell me the top video title" | A Chrome window opens with its own VYRSE profile (separate from your normal Chrome) |
| 6 | In that Chrome window, sign in to a site once; ask VYRSE to use it later | It stays signed in |
| 7 | Create a test folder, then "delete the folder C:\…\test with rm -rf" | **VYRSE wants permission** dialog. Try Deny, then repeat in a *new* conversation and Allow once |
| 8 | "Switch to the light theme and open settings" / "back to dark" | The UI changes, and the change survives a restart |
| 9 | "Turn on gaming mode" | GAMING badge; the local model is unloaded (GPU memory drops in Task Manager) |
| 10 | Settings → Intelligence → switch the model to Gemma, ask something | Answer from Gemma (slower); switch back |
| 11 | Settings → Skills → search "weather", inspect one, install, remove | Installs (Hermes scans it first), then removes |
| 12 | Say **"VYRSE"** ("wairz"), pause briefly, ask "what time is it?" | Soft chime → orb listens → spoken answer in ~3 s |
| 13 | After it answers, ask a follow-up *without* the wake word within ~6 s | It hears and answers |
| 14 | While it is speaking, start talking over it | It stops and listens (works best with headphones) |
| 15 | Tap the mic button instead of using the wake word | Same as 12 |
| 16 | Close VYRSE, then check Task Manager | No `python` (Hermes) or `llama-server` left running* |
| 17 | While it's running, kill the `python … hermes_cli.main serve` process in Task Manager | Banner "Reconnecting…", then it recovers and keeps your conversation |

\* If you also run Hermes yourself (CLI), that Hermes owns the model server and it keeps running — by design.

## Tuning
- Wake word too sensitive / not sensitive enough: Settings → Voice → *Speech sensitivity*;
  stricter matching: `hermes config set wake_word.heed.consecutive_frames 3`.
- Misheard words: Settings → Voice → Recognition → *Accurate* (slower).
- Typed answers too slow: Settings → Intelligence → *Reasoning when typing* → Low.
- Spoken answers too shallow: Settings → Voice → *Reasoning when talking* → Low.

## If something goes wrong
- Banner with *Show details* → the Hermes log tail. Full log: `%APPDATA%\vyrse-desktop\logs\hermes-backend.log`.
- Hermes' own logs: `%LOCALAPPDATA%\hermes\logs\agent.log` (agent, wake word, speech), `llama-server.log` (model).
- Note what you said or typed and the time; that's enough for me to find it in the logs.
