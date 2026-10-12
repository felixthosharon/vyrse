// Status pill window (see desktop/src/main/orb.ts): mirrors VYRSE's presence with a short caption.
(() => {
  const bridge = window.vyrse && window.vyrse.desktop;
  const DEFAULTS = {
    listening: "Listening…",
    thinking: "Thinking…",
    working: "Working on it",
    speaking: "Speaking",
    reminder: "Reminder",
    error: "Something went wrong",
    success: "Done",
  };
  // Same theme and glass level as the app (its settings live in this origin's localStorage).
  function applyLook() {
    let settings = {};
    try {
      settings = JSON.parse(localStorage.getItem("vyrse.settings.v1") || "{}") || {};
    } catch {}
    const theme = settings.theme || "system";
    const light = theme === "light" || (theme === "system" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.classList.toggle("light", light);
    document.documentElement.dataset.glass = settings.glass || "liquid";
  }
  applyLook();
  window.addEventListener("storage", applyLook);
  const pill = document.getElementById("pill");
  const label = document.getElementById("label");

  pill.addEventListener("click", () => bridge && bridge.showMain());
  // The window is click-through except over the pill.
  pill.addEventListener("mouseenter", () => bridge && bridge.setInteractive && bridge.setInteractive(true));
  pill.addEventListener("mouseleave", () => bridge && bridge.setInteractive && bridge.setInteractive(false));

  const render = (state, text) => {
    if (state.presence === "reminder") {
      label.textContent = "";
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = "Reminder · ";
      label.append(sub, document.createTextNode(text));
    } else {
      label.textContent = text;
    }
  };

  let shownText = null;
  let swap = null;
  if (!bridge) return;
  bridge.onOrbState((state) => {
    document.body.dataset.presence = state.presence;
    const text = state.label || DEFAULTS[state.presence] || "VYRSE";
    const key = state.presence + "|" + text;
    if (shownText === null) {
      render(state, text);
    } else if (key !== shownText) {
      // Soft cross-fade when the caption changes.
      clearTimeout(swap);
      label.classList.add("changing");
      swap = setTimeout(() => {
        render(state, text);
        label.classList.remove("changing");
      }, 160);
    }
    shownText = key;
    requestAnimationFrame(() => document.body.classList.add("shown"));
  });
})();
