# Vyrse Presence

VYRSE COMPLETE UI REDESIGN

You are working on Vyrse, a voice-first personal AI interface.

I want a major visual redesign of the entire frontend.

Do NOT treat this as a small polish pass.

You are allowed to redesign the UI structure, spacing, components, controls, typography, buttons, responsive behavior, presence/orb system, transcript presentation, and visual language from the ground up.

However, do not break existing functionality, API boundaries, state management, microphone behavior, persistence, or backend integration.

The attached reference image is the visual direction for the new Vyrse experience. Use it as inspiration for the overall composition, presence system, light/dark themes, responsiveness, and interaction language.

1. THE CORE VISION

Vyrse should feel like:

A quiet, premium, always-present personal AI — not a generic AI chatbot.

It should feel closer to a carefully designed Apple-quality system interface than a typical AI SaaS website.

Think:

Apple-level restraint

futuristic but not "AI generated"

minimal

calm

highly polished

responsive

tactile

intelligent

alive

spatial

voice-first

Avoid:

generic ChatGPT layouts

generic Claude layouts

generic Gemini layouts

purple AI gradients everywhere

excessive glassmorphism

neon cyberpunk

giant glowing blobs

dashboard-like layouts

unnecessary cards

excessive borders

excessive shadows

visual clutter

The interface should feel designed, not decorated.

2. IMPORTANT: REBUILD THE ORB / PRESENCE COMPLETELY

This is one of the most important requirements.

Do NOT simply modify the existing orb.

Replace/rebuild the current presence renderer from the ground up.

The current orb should NOT remain as the foundation if that limits the new design.

The reference image demonstrates the intended direction:

a central circular presence

multiple thin orbital/contour rings

flowing intelligent lines

particles/nodes

subtle asymmetric movement

continuous motion even while idle

energy flowing around the central form

layered depth

elegant rather than noisy

no obvious planet texture

no realistic spherical rendering

no "ChatGPT moon" appearance

The center should feel like the core of an intelligent system, while the surrounding rings/fields communicate its activity.

It should feel like something that is alive and computational, not like a planet floating on a webpage.

Very important:

The orb/presence should remain large and visually dominant.

Do NOT make it tiny simply because the viewport becomes larger.

Instead:

available space
        ↓
calculate maximum safe presence size
        ↓
grow presence
        ↓
stop only when it would overlap another important UI element


The orb should always use the largest visually appropriate size possible without overlapping or breaking the layout.

This applies to:

phones

tablets

laptops

1080p monitors

1440p monitors

ultrawide monitors

4K monitors

large desktop displays

TV-sized viewports

Do NOT use a lazy fixed max-width: 400px / 420px / 500px solution.

The presence should scale intelligently with the viewport.

3. THE PRESENCE MUST FEEL ALIVE WHILE IDLE

Idle should NOT mean frozen.

Even when nothing is happening:

rings should slowly move

particles should drift

lines should subtly orbit

small nodes should move

energy should circulate

the core should breathe very subtly

the field should continuously evolve

But this movement must be slow and calm.

No flashy screensaver effect.

Think:

"Something is quietly awake."

4. PRESENCE STATES

The presence should visually communicate Vyrse's state.

At minimum:

IDLE

Calm.

slow orbital movement

low energy

subtle breathing

minimal particle movement

LISTENING

Strongly voice-reactive.

rings respond to microphone amplitude

field expands/contracts

particles react to voice

energy becomes more active

microphone state becomes obvious

THINKING / PROCESSING

The system is working.

orbital movement becomes more directional

particles accelerate subtly

inner/outer rings change speed

field becomes slightly more concentrated

no seizure-inducing animation

SPEAKING

Vyrse is talking.

The presence should react to generated audio.

rings pulse with speech

energy flows outward/inward

particles react subtly

speaking should visually feel different from listening

ERROR / INTERRUPTED

Use a restrained visual signal.

Do not turn the entire interface red.

5. MICROPHONE INTERACTION

Vyrse is voice-first.

The microphone should NOT look like a tiny speech-to-text button attached to a chatbot composer.

The microphone is one of the primary interaction mechanisms.

Use the reference interaction concept:

Idle

A subtle microphone control exists near/below the presence.

Hover / focus

The microphone becomes more visible.

Listening

The button becomes clearly active:

stronger glow

subtle pulse

microphone icon

surrounding activity

"I'm listening" indicator

Muted / stopped

The icon changes appropriately.

Important:

On large screens, text such as:

"I'm listening"

must NEVER overlap the microphone button.

The listening status must have its own responsive layout space.

This bug has already happened before, so explicitly protect against it.

6. VOICE-FIRST COMPOSER

The text composer still exists because typing is useful.

But it should visually communicate:

"You can type if you want."

rather than:

"This is a chatbot and there's a microphone button."

The microphone should feel like the primary interaction.

The text composer should be:

minimal

compact

elegant

unobtrusive

Apple-like

visually subordinate to the presence

Redesign the send button if necessary.

You are completely free to redesign:

send button

microphone button

icons

borders

hover states

focus states

input styling

placeholder styling

as long as the result stays minimal and coherent.

7. CONVERSATION / RESPONSE EXPERIENCE

Do NOT turn the main screen into a traditional chat application.

The presence should remain the primary visual anchor.

When Vyrse responds, show a compact streaming response surface beneath/near the presence.

The response area should:

stream text naturally

automatically scroll as new content arrives

remain compact by default

never push the presence awkwardly around

never make the orb tiny

never cause the entire page to become a normal chat feed

If the response becomes long, the compact surface should have its own scrolling behavior.

8. EXPANDED TRANSCRIPT

When the user wants to see the entire conversation, provide an expanded transcript mode.

Important:

Do NOT implement this as a random browser-like popup window.

It should feel like the interface is transforming into a workspace.

Use a smooth spatial transition:

COMPACT MODE

      PRESENCE
         ↓
   short response
         ↓
     composer


becomes:

EXPANDED MODE

PRESENCE          TRANSCRIPT
large             conversation
                  conversation
                  conversation
                  conversation


The presence can gracefully move to the side when there is enough room.

On smaller screens it may move upward.

The transition should feel intentional and smooth.

Do NOT abruptly teleport elements.

Do NOT destroy the presence.

Do NOT shrink the presence unnecessarily.

9. EXPANDED TRANSCRIPT RESPONSIVENESS

This is extremely important.

Do NOT assume:

desktop = one fixed layout

Instead calculate the layout based on available space.

For example:

Large desktop / TV

Presence gets substantial space.

Transcript gets a comfortable readable width.

Normal desktop

Presence remains large.

Transcript occupies a balanced portion of the screen.

Laptop

Reduce spacing before reducing presence size.

Tablet

Stack intelligently.

Mobile

Presence remains visually dominant.

Transcript becomes a compact scrollable region.

Never let:

transcript overlap presence

microphone overlap status text

composer overlap transcript

content overflow horizontally

huge dead margins appear

presence become microscopic

10. LARGE SCREEN / TV SUPPORT

This is a hard requirement.

Test the design mentally and structurally at:

320px
375px
430px
768px
1024px
1280px
1440px
1600px
1920px
2560px
3840px


Also consider very wide aspect ratios.

The UI should not simply stretch everything.

Use:

fluid sizing

clamp()

viewport-aware calculations

sensible max-widths

container queries where appropriate

CSS grid/flex intelligently

safe spacing constraints

The design should look intentional on a 27" monitor and still feel natural on a phone.

11. LIGHT MODE

Light mode needs its own visual treatment.

Do NOT simply invert the dark theme.

The reference demonstrates that the presence itself can have a different light-mode rendering.

Create a dedicated light-mode presence palette.

Possible direction:

soft graphite

cool stone

glacier blue

pale cyan

subtle warm highlights

muted lavender only where appropriate

The background should NOT be pure white.

Avoid:

#ffffff everywhere


Use a soft off-white / stone / cool neutral background with extremely subtle gradients.

The presence must remain visible.

Most importantly:

NO RECTANGULAR GLOW

There must be absolutely no:

rectangular gradient behind the orb

square halo

canvas-sized glow

visible gradient box

fillRect()-style halo artifact

compositing artifact around the presence

The presence's glow should be radial and spatially contained.

If necessary, clip/mask the rendering properly.

The light-mode orb should look intentional, not like a dark orb placed on a white webpage.

12. DARK MODE

Dark mode should be the strongest version of the experience.

Use a deep graphite/near-black environment rather than pure black.

The presence can use:

cyan

electric blue

subtle violet

deep indigo

occasional white specular highlights

But keep saturation controlled.

Do NOT turn it into cyberpunk neon.

The reference image's cyan/blue/violet orbital field is the correct general direction.

13. COLOR SYSTEM

Create an actual design system.

Do not randomly assign colors to components.

Define semantic tokens such as:

--background
--surface
--surface-elevated
--border
--text-primary
--text-secondary
--text-muted
--accent
--presence-primary
--presence-secondary
--presence-highlight
--presence-glow


Dark and light themes should have different values.

The entire application should feel like one visual system.

Accent colors should subtly appear throughout:

presence

microphone

active states

focus states

tiny indicators

streaming indicator

selected settings

transitions

But don't add gradients to every component.

14. APPLE-LIKE DESIGN LANGUAGE

Use Apple-inspired principles, NOT Apple's actual design.

Focus on:

generous but purposeful spacing

typography hierarchy

subtle borders

restrained shadows

smooth transitions

tactile controls

minimal chrome

clear hierarchy

almost invisible UI until needed

Buttons should feel:

"I know exactly what this does."

not:

"LOOK AT THIS BUTTON."

15. ANIMATIONS

Animation is a major part of the identity.

Use animation to communicate:

state

focus

transition

presence

activity

Not decoration.

Examples:

Initial launch

Very subtle:

background appears

presence materializes

orbital field initializes

controls fade in

composer settles into position

Avoid dramatic cinematic animations.

Presence transitions

Idle → listening → thinking → speaking should feel continuous.

Never abruptly replace the entire orb.

Transcript expansion

Use smooth movement and resizing.

Mic hover

Subtle scale/glow.

Streaming

Use a restrained streaming indicator.

16. PERFORMANCE

The presence may use Canvas/WebGL/custom rendering if appropriate.

However:

do not create unnecessary render loops

properly clean up animation frames

properly clean up observers

properly clean up microphone/audio resources

avoid unnecessary React re-renders

pause expensive rendering when the page is hidden if appropriate

respect prefers-reduced-motion

The presence should feel smooth on normal hardware.

17. DO NOT BREAK THE EXISTING ARCHITECTURE

This is critical.

Before changing anything:

inspect the existing project.

Understand:

components

state management

Vyrse API boundary

Foundry integration

microphone/audio implementation

persistence

transcript logic

theme system

renderer

services

Do not replace working backend/API functionality simply because the UI is being redesigned.

The goal is:

new visual system + same working application

unless a frontend architecture change is genuinely necessary for the redesign.

If something needs restructuring, do it cleanly rather than layering hacks on top of the old implementation.

18. DO NOT CREATE DUPLICATE SYSTEMS

Before implementing anything, search for existing:

presence renderers

microphone controllers

transcript components

theme logic

state definitions

animation systems

Do not create a second competing implementation.

If an old implementation is being replaced, remove or disconnect it cleanly.

I do NOT want:

old orb
+
new orb
+
old animation
+
new animation
+
three different theme systems


I want one coherent implementation.

19. RESPONSIVE RULE

This is one of the highest-priority requirements:

The presence should be as large as possible without causing overlap or destroying readability.

Do not arbitrarily reduce its size because there is extra whitespace.

If there is empty space, use it.

The presence should feel like the center of the application.

Only reduce its size when the actual available space requires it.

20. VISUAL HIERARCHY

The final hierarchy should be:

1. Vyrse presence
2. Voice state / microphone
3. Current response
4. Composer
5. Secondary controls


Not:

1. Chatbox
2. Sidebar
3. Cards
4. Buttons
5. Tiny orb


Vyrse is a presence, not a chat dashboard.

21. REMOVE VISUAL NOISE

You have permission to redesign/remove/reorganize existing UI elements.

If something does not contribute to the experience:

remove it or make it secondary.

Don't preserve unnecessary UI simply because it already exists.

The final result should feel like someone opened a beautifully designed AI device/interface.

Not like someone opened a SaaS dashboard.

22. REFERENCE IMAGE

Use the attached reference image as the visual direction.

Pay particular attention to:

orbital presence

ring structures

particles

cyan/blue/violet energy

light-mode presence

dark-mode presence

microphone interaction

compact response surface

expanded transcript

responsive composition

However:

Do not blindly reproduce the reference.

Use it as a design language and improve it where appropriate.

If you can make the final design cleaner, more minimal, more responsive, or more premium than the reference, do so.

23. QUALITY BAR

Before considering the work complete, inspect the entire UI as if this were going to ship as a real product.

Check:

no overlapping elements

no clipped content

no horizontal scrolling

no microscopic orb

no enormous dead spaces

no rectangular presence halo

no light-mode washout

no unreadable text

no mic/status collisions

no transcript overflow

no broken expanded mode

no broken mobile layout

no broken tablet layout

no broken desktop layout

no broken ultra-wide layout

no unnecessary UI clutter

no duplicated renderer systems

no broken existing functionality

Test the layout logic across the full range of viewport sizes rather than designing only around the current browser window.

24. MOST IMPORTANT INSTRUCTION

Do not stop at "making the existing UI prettier."

I want a genuine Vyrse redesign.

You can change:

layout

component structure

typography

buttons

controls

transcript design

presence renderer

animations

spacing

theme

responsive behavior

visual hierarchy

as necessary.

But the final result must remain:

clean + minimal + premium + voice-first + futuristic + alive + practical.

And above everything:

Vyrse should look like its own product.

It should NOT look like ChatGPT.

It should NOT look like Claude.

It should NOT look like Gemini.

It should NOT look like a generic Lovable AI template.

It should feel like a personal computational presence that happens to have a UI.

Take the time to inspect the existing project first, then implement the redesign systematically rather than making isolated CSS patches.

Do not ask me to manually fix things that you can solve inside the project.

Do not remove working backend/API functionality.

Do not shrink the presence unnecessarily.

Do not preserve the old orb just because it already exists — rebuild the presence renderer if necessary.

Do not create a rectangular glow around the presence.

Make it beautiful. Make it responsive. Make it feel intentional.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/0501e8ba-bde8-4c3d-b8c8-3d69a4ee4797).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
