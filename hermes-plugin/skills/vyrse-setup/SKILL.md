---
name: vyrse-setup
description: "The personal setup interview ('let's set you up', 'get to know me', 'redo my profile'): ask the user about themselves one question at a time, note each answer with vyrse_profile, then save it into VYRSE's personality."
version: 1.0.0
author: VYRSE
license: MIT
metadata:
  hermes:
    tags: [VYRSE, setup, onboarding, personalisation, profile]
---

# Getting to know the user

A short, friendly conversation (about two minutes) that tailors VYRSE to this person. It feels like a chat,
not a form. The answers fill a "Getting to know you" card in the workspace as you go, and at the end they're
saved into VYRSE's personality (SOUL.md), on top of the preset, which stays as it is.

## How to run it
1. Call `vyrse_profile action=start` (shows the empty card).
2. Open warmly in one or two sentences: you'd like to set yourself up for them, it takes a couple of
   minutes, they can skip anything. Then ask question 1.
3. Ask ONE question per message, in the user's talk style, short enough to answer out loud. React to the answer
   in a few words (genuinely, not "great answer!"), then call `vyrse_profile action=note` with the field and a
   short plain summary of what they said (their words where possible), then ask the next question.
4. If they skip a question, move on (don't note it). If an answer already covers a later question, note both.
5. When all are asked, call `vyrse_profile action=save`. It shows them the summary to confirm. If they want
   changes, ask what to fix, note it again, and save again.
6. After it's saved: save 3-5 of the most useful facts with the `memory` tool (name, city, what they do, their
   main use for VYRSE, key preferences), thank them in a sentence, and suggest ONE thing to try based on what they
   said (e.g. a student: "try 'quiz me on my notes'"; a gamer: "ask me to watch your GPU while you play").

## The questions (field: what to learn)
1. `role`: who they are and what they do (student and what they study, job, creator, gamer…).
2. `uses`: what they'll mostly use VYRSE for (studying, coding, gaming, work, everyday PC chores, just chatting…).
3. `day`: what their day looks like: when they're usually up, school or work hours, when they go to bed.
4. `apps`: the apps and games they use most.
5. `answers`: how they like answers: short or detailed, and how much humour or roasting they're up for.
6. `interests`: what they're into (music, sports, shows, topics) and what news they care about.
7. `city`: where they are, for weather and the morning briefing (city only; skip if they'd rather not).
8. `never`: anything VYRSE should never do or always check first.

## Rules
- Never ask for passwords, addresses, phone numbers, health or money details; if offered, don't note them.
- Don't change the talk style or settings yourself during the setup; the profile adds to how VYRSE helps, it
  doesn't replace VYRSE's personality.
- Keep the whole thing moving: no long explanations between questions.
