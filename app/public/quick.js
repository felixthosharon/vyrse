// Quick-ask bar: send a question to VYRSE from anywhere and show the streamed answer.
// The answer is built from DOM nodes (textContent only), never HTML, so a reply can't inject markup.
(() => {
  const quick = window.vyrse && window.vyrse.quick;
  const body = document.body;
  const bar = document.getElementById("bar");
  const input = document.getElementById("input");
  const answer = document.getElementById("answer");
  const status = document.getElementById("status");
  const hint = document.getElementById("hint");
  if (!quick) return;

  let currentId = null;

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

  function inline(parent, text) {
    // **bold** and `code`; everything else is plain text.
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const token = m[0];
      const el = document.createElement(token.startsWith("**") ? "strong" : "code");
      el.textContent = token.startsWith("**") ? token.slice(2, -2) : token.slice(1, -1);
      parent.append(el);
      last = m.index + token.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(text) {
    answer.replaceChildren();
    const lines = String(text || "").split("\n");
    let para = [];
    let list = null;
    const flush = () => {
      if (para.length) {
        const p = document.createElement("p");
        inline(p, para.join(" "));
        answer.append(p);
        para = [];
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("```")) {
        flush();
        list = null;
        const code = [];
        for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
        const pre = document.createElement("pre");
        const c = document.createElement("code");
        c.textContent = code.join("\n");
        pre.append(c);
        answer.append(pre);
        continue;
      }
      const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
      if (bullet) {
        flush();
        if (!list) {
          list = document.createElement("ul");
          answer.append(list);
        }
        const li = document.createElement("li");
        inline(li, bullet[1]);
        list.append(li);
        continue;
      }
      list = null;
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        const p = document.createElement("p");
        p.className = "h";
        p.textContent = heading[1];
        answer.append(p);
      } else if (!line.trim()) flush();
      else para.push(line.trim());
    }
    flush();
  }

  function resize() {
    requestAnimationFrame(() => quick.resize(Math.ceil(bar.getBoundingClientRect().height) + 12));
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      quick.hide();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      currentId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      body.classList.add("busy", "has-answer");
      render("");
      status.textContent = "thinking";
      hint.hidden = true;
      quick.ask(currentId, text);
      resize();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") quick.hide();
  });
  document.getElementById("open").addEventListener("click", () => quick.openMain());

  quick.onUpdate((u) => {
    if (!u || u.id !== currentId) return;
    if (u.text) render(u.text);
    status.textContent = u.done ? (u.error ? "couldn't finish" : "done") : (u.activity || (u.text ? "writing" : "thinking")).toLowerCase();
    if (u.done) {
      body.classList.remove("busy");
      input.value = "";
      input.placeholder = "Ask a follow-up…";
      hint.hidden = false;
    }
    resize();
  });

  quick.onShow(() => {
    applyLook();
    body.classList.add("shown");
    input.focus();
    input.select();
    resize();
  });
  quick.onHide(() => body.classList.remove("shown"));
})();
