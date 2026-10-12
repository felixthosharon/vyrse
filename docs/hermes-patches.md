# Hermes core patches

VYRSE keeps Hermes changes minimal. Patches are applied as working-tree edits on the Hermes
checkout (`%LOCALAPPDATA%\hermes\hermes-agent`, branch `main`): `hermes update` auto-stashes
local edits and re-applies them after pulling. The canonical copies live in `hermes-patches/`;
`scripts/setup.ps1` re-applies any that are missing (`git apply --check` first).

| Patch | Why |
|---|---|
| `0001-skills-search-description.patch` | Bug fix: `skills.manage search` called `SkillMeta.describe()`, which doesn't exist (the field is `description`), so hub search over the gateway always failed with code 5024. One-line, upstreamable. |

Plugin TTS streaming turned out not to need a patch (module-level registry in `tools.tts_streaming`).

| `0002-plugin-wake-engines.patch` | Adds `tools.wake_word.register_wake_engine(name, cls)`: `_build_engine` and `check_wake_word_requirements` honour plugin engines (the plugin's `available()` answers the dependency probe). Without it a plugin engine would be misreported as missing openWakeWord deps. Upstreamable, generic. |

## 0003 — computer_use: skip own windows on Windows (`tools/computer_use/cua_backend_capture.py`)
- Bug: implicit captures skip cua-driver's own windows by normalized app name `cuadriver`, but Windows
  reports `cua-driver.exe`, so the always-on-top cursor overlay became the capture target and the driver
  refused ("refuses operations that target its own authorization process"). Fix: strip `.exe`.
- Addition: `computer_use.skip_window_titles` (list) lets a front-end exclude its own always-on-top
  widgets (VYRSE sets `["VYRSE orb"]`).
- VYRSE also sets `computer_use.no_overlay: true`.

## 0004 — tool search: always-loaded tools (`tools/tool_search.py`)
- With tool search active, every plugin tool is deferrable, so VYRSE's own tools sat behind a
  search + describe round trip (two extra slow model calls per task).
- Adds `tools.tool_search.eager: [names]`, checked before `defer`. VYRSE lists its five plugin tools;
  `computer_use` stays deferred.

## 0005 — local runtime: per-model launch overrides (`hermes_cli/local_runtime/presets.py`)
- The planner reserves ~4.5 GB on an 8 GB card (2 GB margin + 1 GB launch headroom + 1.5 GB runtime
  overhead). For Qwen 3.5 9B (hybrid) it then spills the FFNs of all 24 recurrent blocks to the CPU
  for both Q4_K_M and Q3_K_M (~14 tok/s).
- Adds `local_runtime.launch_overrides.<model_id>: {ctx, ubatch, gpu_layers: all|N}`, applied after
  the plan (no override = unchanged behaviour). Hermes' 64K minimum context still applies.
- Measured with Hermes' llama.cpp b11146, 64K ctx, q8 KV, flash attention, fully on the RTX 3070:
  - Q4_K_M: 66 tok/s, 6.7 GB
  - Q3_K_M: 65 tok/s, 5.9 GB
- With the desktop using 0.7–2 GB, Q4 overflows into shared memory, so VYRSE runs Q3_K_M
  (`{ctx: 65536, ubatch: 512, gpu_layers: all}`) as default. Q4 keeps the planner's safe plan.
- 0005 also accepts `mmproj`, `mmproj_offload` and `image_max_tokens` (vision projector on the CPU).
- 0005 also accepts `chat_template_file` (Jinja template replacing the GGUF's own; VYRSE uses it to
  give Gemma 3 tool calling).

## 0006 — model switch before a session's first turn (`tui_gateway/model_switch.py`)
- A switch on a session whose agent isn't built yet set `model_override`, but the deferred build
  prefers `resume_runtime_overrides` (the stored runtime), so the pick was silently dropped. The
  switch now also merges the pick into `resume_runtime_overrides`, as the failed-build restart does.

## 0007 — an output cap for desktop sessions (`tui_gateway/agent_callbacks.py`, `tui_gateway/server.py`)
- Desktop/TUI sessions build the agent with no `max_tokens`, and the local provider profile sends none,
  so a looping model generates until the server dies. On 2026-10-12 Qwen made 41,549 tokens (15 min) for
  "make me flashcards".
- `llama-server --n-predict` doesn't help: the OpenAI chat endpoint ignores it (measured: 8,095 tokens
  with `-n 6144`).
- Adds `agent.max_output_tokens` (unset = unchanged behaviour). VYRSE sets 6144. A cut reply is still
  continued by Hermes (up to 4 times, thinking off after a thinking-only cut), so a runaway is bounded at
  about 30k tokens.
