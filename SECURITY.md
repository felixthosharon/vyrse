# VYRSE security notes

What is exposed, how it is protected, and the risks accepted on purpose.

## Desktop app (Electron)
- Hermes listens on 127.0.0.1 only, with a random 32-byte token; the token goes only to VYRSE's own pages
  (`guard.ts` checks the sender of every connection request).
- Every window: `contextIsolation`, `sandbox`, no Node. No `<webview>`, no new windows, VYRSE's pages never
  navigate away; external links open in the browser (http/https only). Only the microphone permission is granted.
- UI CSP: `script-src 'self'` (no inline script), `connect-src` limited to 127.0.0.1. The UI never renders
  model output as HTML (React text only; images only as `data:` URLs).
- Shipped binary: Electron fuses off for RunAsNode, NODE_OPTIONS, inspector flags; ASAR integrity validation
  and app-from-ASAR only; dev switches (`VYRSE_RENDERER_URL`, `VYRSE_SMOKE`) are ignored when packaged.
- Secrets (Alexa session, ngrok token, Echo skill config, paired phones) are encrypted with Windows DPAPI
  (`safeStorage`); the Voice Monkey token stays in `%HERMES_HOME%` and is never sent to the UI.

## Phone bridge (home Wi-Fi, port 47630, off until enabled)
- Answers private (RFC 1918 / link-local / loopback) addresses only; Windows firewall rule is Private + local subnet.
- Pairing: 6-digit code shown on the PC, 2 minutes, 5 tries. Each phone gets its own random key, stored on the
  PC only as a SHA-256 hash (constant-time compare), revocable in Settings.
- A paired phone reaches only what the app uses: an allowlist of Hermes REST endpoints, two WebSockets
  (`/api/ws`, `/api/audio/speak-stream`) and, on the gateway socket, an allowlist of JSON-RPC methods.
  Hermes' files/terminal/env/plugin-management endpoints are refused.
- The phone never receives Hermes' token (the bridge swaps it in).
- Accepted risk: traffic on the Wi-Fi is plain HTTP (the user chose plain Wi-Fi over Tailscale). Someone already
  on the home network who can intercept traffic could capture a phone key; remove the phone in Settings → Phone
  to revoke it.

## Echo skill gateway (internet, via ngrok, off until enabled)
- Local server on 127.0.0.1 behind ngrok; only `POST /alexa/<random secret path>` is answered; Hermes is never tunnelled.
- Every request is verified with Node's crypto (`amazon-verify.ts`): Amazon certificate URL, certificate chain to
  a trusted root naming echo-api.amazon.com, SHA-256 RSA signature of the exact body, timestamp within 150 s;
  then this skill's ID and the one linked Amazon user. Body size is capped.

## Hermes plugin
- PowerShell helpers receive requests as base64 JSON (no command-line injection); file search terms are
  reduced to letters/digits; `open` only takes local drive paths (no `\\server` shares, no protocol links) and
  never starts programs or scripts.
- Alexa purchases need an on-screen yes; Private mode blocks online tools.
- Microphone test recordings: only the latest 5 are kept.

## Android app
- Release build is signed with the VYRSE key (kept outside the repo, `%LOCALAPPDATA%\vyrse-build\signing`,
  readable only by the user) and is not debuggable (WebView can't be inspected).
- No backups or device-to-device transfer (the pairing key never leaves the phone).
- Talks only to the paired PC: a runtime CSP pins `connect-src` to the bridge address.
- Phone actions are a fixed set (battery, flashlight, ring, media keys, volume, notifications, show a
  notification); notifications are read only when asked and only with Android's notification access on.

## Known, accepted dependency findings
- `braces` (via alexa-remote2 → alexa-cookie2 → http-proxy-middleware): denial of service with deeply nested
  glob patterns. The patterns are fixed in code (the local Amazon sign-in proxy), never user input.
