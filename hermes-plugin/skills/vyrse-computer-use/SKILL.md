---
name: vyrse-computer-use
description: "Use the user's PC and their own Chrome like a careful person: look first, act, check. Pointing ('show me where'), clicking icon buttons, websites with their logins, and looking up how-to steps instead of guessing."
version: 1.0.0
author: VYRSE
license: MIT
metadata:
  hermes:
    tags: [computer-use, chrome, browser, desktop, pointing, VYRSE]
---

# Using the PC and Chrome with VYRSE

The loop for every task: **look → act → check**. Never act on a guess, and never report something you didn't see.

## Which tool
| The user means | Tool |
|---|---|
| A website, anything in Chrome, "my Gmail/YouTube/Amazon" | `vyrse_chrome` (their own Chrome: their logins and tabs) |
| A Windows app (Explorer, Notepad, Settings, Spotify, Discord app…) | `vyrse_desktop` |
| "Where is…", "show me how to…" (they want to do it themselves) | `vyrse_point` (rings, nothing clicked) |
| You don't know the steps in some app | `vyrse_point` action=how (looks them up on the web) |
| Something only pixels show (a chart, an image, a game) | `vyrse_chrome` look / `vyrse_screen` |

## Chrome (`vyrse_chrome`)
1. `read` the page first. You get its text and numbered controls: `[7] button (icon, no label) icon:bell`.
2. Act on a number: `click` ref=7. Or describe it: `click` target="the bell icon" / "Subscribe" (VYRSE looks at the
   page and picks it, or says nothing matches).
3. After a click that changes the page, `read` again before the next step. Numbers from an old read go stale.
4. Typing: `type` target="search box" text="…" submit=true. Fields are cleared first.
5. Web apps that draw their own interface (Word/Excel online, Google Docs, Figma, games) list few or no
   controls. That's fine: use `target` with the visible text or what it looks like (`click` target="File", then
   target="Export to PDF"); VYRSE reads the screen and finds it. Never say you can't control the page.
6. Not visible? `scroll` down and read again. Still not there? Say so. Don't invent it.
7. Facts from a page come from `read` or `look`, never from memory.

Routes:
- **Search the web**: `search` query → `read` → open the best result (`click` it) → `read`.
- **Gmail: find an email**: `open` mail.google.com → `type` target="Search mail" text=… submit=true → `read`.
- **YouTube: play something**: `open` youtube.com/results?search_query=… → `read` → `click` the video title.
- **A form**: `read` → one `type` per field (target = its label) → `read` to check → click the submit button
  only when the user asked you to submit.
- Sending, buying, posting, deleting: say what you're about to do and get a yes first.

If `vyrse_chrome` says the extension isn't connected, tell the user the one-time setup it describes. Don't switch
to some other browser silently.

## Windows apps (`vyrse_desktop`)
- `click` name can be the label or what an icon looks like ("the gear", "trash can"); VYRSE looks at the window
  to find it. If it answers that nothing matches, believe it: read the window (`read`) or ask.
- `read` before you describe what an app shows.

## On-screen jobs (`vyrse_point`): ONE call
- "highlight / where do I click / how do I … / walk me through": `vyrse_point` action=guide goal="export as PDF".
  It works out the app (Chrome tab and site included), looks up the real steps, rings step 1, and moves on each
  time they click the ring.
- "do it for me / just export it": action=do goal="…". VYRSE clicks the steps itself and reports how far it got.
- One control ("where's the share button?"): action=show target="share".
- Don't chain other tools for these, don't use the terminal, and don't write steps from memory.

## Honesty rules
- "I looked and it's not there" is a good answer. A wrong click is a bad one.
- Never claim a click, a message sent or a form submitted unless the tool result says so.
- Say where facts came from when they came from a lookup ("Discord's help page says…").
