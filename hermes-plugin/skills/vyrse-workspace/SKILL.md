---
name: vyrse-workspace
description: "Build dashboards in VYRSE's workspace with vyrse_workspace, vyrse_analyse and vyrse_log: recipes for analysing data files, PC health and live monitoring, comparisons, plans, budgets, study sessions, logs and mini apps."
version: 1.0.0
author: VYRSE
license: MIT
metadata:
  hermes:
    tags: [VYRSE, workspace, dashboard, charts, analysis, logging]
---

# Workspace dashboards

The workspace is the panel beside the chat. Each `vyrse_workspace` call with `action=show` adds one item;
several items make a dashboard. The newest item goes on top, so **show the summary item last**.
The chat reply stays one or two sentences: the headline finding, with the key fact in bold.

## When to use it (and when not)
- Use it for: analysing data or files, comparing options, numbers over time, monitoring, plans and
  to-dos, logs and tracking, reports, study material, anything with more than ~4 facts.
- Skip it for: small talk, a yes/no, one number, a quick fact. Just answer.

## Picking the kind
Pick the picture, not the table. A table is for several columns of text (specs side by side); numbers
almost always read better as a chart, stats, rings or gauges.

| You have | Show |
|---|---|
| numbers over time | `chart` line (`threshold` for a limit, `highlight` the peak) |
| a few categories to compare | `chart` bar, `highlight` the winner or the worst |
| parts of a whole (disk, budget, time spent) | `chart` donut |
| 2 to 6 headline numbers | `stats` (`change` "+12%", `trend` for a sparkline) |
| live levels: temps, CPU, RAM, battery | `gauges` (`warn` = where it turns red) |
| goals, done vs target, % of a limit (CPU, RAM, disk, battery) | `rings` (or `gauges` for live levels), never a donut |
| options side by side | `table` (`highlight` the recommended row) |
| a briefing, a summary, pros and cons, tips | `cards` with icons |
| tasks | `checklist` (to tick) or `board` (To do / Doing / Done) |
| something per day (habits, activity) | `heatmap` |
| a plan with dates | `timeline`; a procedure: `steps` (`done` ticks) |
| a bug | `code` with `lines` = the bad lines, caption = the fix |
| a focus session | `timer` (`minutes`) |
| days until something (exam, trip, birthday) | `timer` with `until` (a date) |
| "pick for me", can't decide, coin, dice | `picker` (items = the options; it spins and picks on screen; never pick yourself) |
| a topic and its parts (study, brainstorm) | `mindmap` (title = the centre, items with `group` = the branch) |
| what's using disk space | `vyrse_system` action=storage show=true |
| anything interactive or custom | `app` (your own small HTML page) |

## Recipes

**Analyse a data file (CSV, Excel, JSON)**
Call `vyrse_analyse` with the path. It reads the file, adds everything up in code (by category, over time,
top items) and puts the dashboard on screen: summary numbers, a breakdown chart, the trend, a table.
Quote its numbers exactly; never add up a file yourself. Pass `by` / `value` / `date` only when the user
names a column ("by merchant"). For a follow-up view it didn't make, show it with `vyrse_workspace`.

**PC health / "how's my PC doing"**
`vyrse_system` action=overview show=true draws the gauges itself. Then, only if something is red, `cards`
with what to do about it (icon `alert`). "What's eating my storage": action=storage show=true (it measures
the folders, never walk them in the terminal); `path` to look inside one big folder.

**Watch something live** ("watch my GPU temp", "graph my CPU for a minute")
Re-show the same `id` every few seconds with new values (gauges or a line chart with `threshold`).
Same id = it updates in place, smoothly. Stop when the user says so or the time is up.

**Compare options** (laptops, phones, plans, models)
`table` with one row per option (first cell = the name), `highlight` your pick, then `cards` with the
verdict: "Best overall", "Best value", "Skip" (icons `trophy`, `money`, `alert`).

**Budget or spending**
`chart` donut by category, `stats` (total, biggest category, vs last month), `table` of the items.

**Study session**
`timer` (e.g. 25 minutes), a `checklist` of what to cover, and `flashcards` for revision. To quiz the
user, use `vyrse_quiz` (it keeps score and ends with a scorecard).

**Plan a day / week / project**
`timeline` for the schedule, `board` for tasks with `group` To do / Doing / Done, `rings` for goals.

**Research or a long answer**
`markdown` report (headings, short paragraphs, a table if useful), then `cards` with the 3 key points.

**Can't decide** ("what should I eat", "pick a movie", "flip a coin")
`picker` with 4 to 10 options as items (ask for them, or suggest good ones that fit what you know about
the user). The wheel spins and picks on screen; reply "Spinning…" and let the wheel decide.

**Learn a topic**
`mindmap` of the topic (`outline`: 4 to 6 branches, 2 to 4 sub-points each), then `flashcards` of the key
facts (`cards`: one per line, `question :: answer`), then offer a quiz (`vyrse_quiz` action=start with
`text`: one per line, `question :: correct answer :: topic`). For an exam: `timer` with `until` = the exam date, and a `checklist` of
what to revise.

**Track a habit or goal**
Goals for later: `rings` (value = done so far, max = the target). When the user does something, log it
with `vyrse_log` and update the rings (same id). A week of a habit: `heatmap` from the log's CSV.

## Logs (`vyrse_log`)
"Log study, chemistry, 20 minutes" means `vyrse_log` action=add, log="study", entry="chemistry",
value=20, unit="min". It saves to a CSV that lasts across chats, and shows the log card (today's total,
the last 7 days, the latest entries). Reply with one sentence: "Logged. That's **95 minutes** today."
"How much did I study this week?" means action=show. "Undo that" means action=undo.
Past days go in one add per day with `when` ("I slept 6, 5 and 7 hours the last three nights": three adds,
when = "3 days ago", "2 days ago", "yesterday"). Keep each log in one unit; if the tool refuses an amount
in another unit, don't force it: log it elsewhere or as an entry without a value.
For a custom view of a log (a month heatmap, a chart by subject), read
`%HERMES_HOME%/vyrse/logs/<name>.csv` and show a `heatmap` or `chart`.

## Mini apps (`kind=app`)
Write one complete HTML document: inline `<style>` and `<script>`, no external files, no network
(fetch, CDNs and fonts are blocked). It runs sandboxed in a card about 200 to 600 px tall and resizes
to its content. Use the theme variables so it matches VYRSE:
`var(--bg) var(--fg) var(--muted) var(--primary) var(--accent) var(--success) var(--card) var(--border)`.
Good uses: calculators and converters, a tip splitter, a dice roller, a Pomodoro with sound, a physics
simulation on a `<canvas>`, a small game, an interactive chart. Keep it small and working; test the
logic in your head before sending. Update it by showing the same `id` again.

## Arranging the board
- `action=focus` with an `id` shows just that item, big (no id = back to all).
- `layout=focus` makes the workspace the main view (for a big dashboard); `split` puts it beside VYRSE.
- `action=remove` (id) drops one item; `action=clear` empties the board before a fresh dashboard.
