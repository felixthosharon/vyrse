# Your AI models go here

Drop a **.gguf** model file into this folder and VYRSE (through Hermes) picks it up: it appears in
Settings -> Assistant -> Model. You don't need llama.cpp: Hermes downloads and runs it for you.

Easiest way instead: run `hermes model` in a terminal and pick a local model; Hermes downloads it.

What fits your GPU (Q4_K_M quantisation):

| GPU memory | Good choice |
|---|---|
| 6-8 GB | a 7-9B model, e.g. Qwen 3.5 9B (what VYRSE is tuned on) |
| 12 GB+ | 12-14B models |
| no NVIDIA GPU | a 3-4B model (slower, but works on CPU) |

Optional: a vision "mmproj" file for a model lets VYRSE see images and your screen; put it next to the model.
