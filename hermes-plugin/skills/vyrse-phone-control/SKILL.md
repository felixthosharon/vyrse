---
name: vyrse-phone-control
description: "Operate the user's Android phone fast with vyrse_phone: per-app routes (WhatsApp, YouTube, Spotify, Instagram, alarms, settings) and the screen-act loop."
version: 1.0.0
author: VYRSE
license: MIT
metadata:
  hermes:
    tags: [Android, phone, WhatsApp, VYRSE]
---

# Phone control with `vyrse_phone`

Every action (tap, type, swipe, key, open_app, open_url) **returns the screen it led to** in `screen`.
Decide the next step from that list. Don't call `screen` again unless an action failed.

## Rules that save steps
- Items are **rows**: a chat or list row carries all its text, e.g. `"Mom · see you soon · 10:42"`.
  Tap the **row** (kind `button`). Never the `image` item next to it: that opens the profile photo.
- Tap by `n` from the latest list. If the thing isn't on screen, search inside the app instead of scrolling.
- `type` only fills the box: it is **not sent**. To send, tap the item whose text is `Send`.
  Never say a message was sent until that tap succeeded.
- Prefer `open_url` deep links and in-app search over scrolling through long lists.
- Sending, paying, deleting, installing and calling pop a yes/no on the PC. If the user says no, stop.
- Payment, banking and password apps are off limits. Say so; don't look for a way around it.

## Routes
**WhatsApp: message someone**
1. `open_app` WhatsApp.
2. Tap the search row (`Ask Meta AI or Search` / `Search`), then `type` the contact's name.
3. Tap the **row** with their name.
4. Tap the message field (`Message`), then `type` the text.
5. Tap `Send`. The PC asks the user to confirm.

**YouTube: play something**
- Fastest: `open_url` `https://www.youtube.com/results?search_query=<words joined with +>`, then tap the first video row.

**Spotify: play a song or artist**
- `open_url` `https://open.spotify.com/search/<words>`, then tap the first result row and the play button.

**Instagram: open a profile**
- `open_url` `https://instagram.com/<username>`.

**Google Maps: directions**
- `open_url` `https://www.google.com/maps/dir/?api=1&destination=<place>`.

**Alarm or timer**
- `open_app` Clock, tap `Alarm` or `Timer`, tap the add (+) row, set the time, tap `Save` / `Start`.

**Wi-Fi, Bluetooth, flashlight, rotation**
- `key` quick_settings, then tap the tile row by its name (switch items show `switch:on/off`).

**Battery, flashlight, ring to find, music play/pause, volume, notifications**
- Use the quick actions (`battery`, `flashlight`, `find`, `media`, `volume`, `notifications`). They're instant and need no screen.

## When stuck
- An action fails: read `screen` once and pick again.
- Nothing matches after 2 tries: take a `screenshot` and look at it with `vision_analyze`.
- After 6 steps without progress: tell the user where you got stuck rather than looping.
