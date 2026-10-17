// Over-the-screen layer (see desktop/src/main/overlay.ts): "show me where" rings, the ghost cursor while VYRSE
// drives an app, and live captions (what it is doing shows in the status pill). Click-through; it tells the shell when it's empty so the
// window can hide.
(() => {
  const page = window.vyrse && window.vyrse.overlayPage;
  const $ = (id) => document.getElementById(id);
  const ACCENTS = { cyan: "95,212,238", violet: "167,139,250", ember: "251,146,60", mint: "74,222,163", rose: "251,113,133" };
  function applyLook() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem("vyrse.settings.v1") || "{}") || {}; } catch {}
    const rgb = ACCENTS[s.accent] || ACCENTS.cyan;
    document.documentElement.style.setProperty("--accent", `rgb(${rgb})`);
    document.documentElement.style.setProperty("--accent-soft", `rgba(${rgb},0.35)`);
  }
  applyLook();
  window.addEventListener("storage", applyLook);

  const shown = new Set();
  const timers = {};
  let idleTimer = 0;
  function on(el, yes) { el.classList.toggle("on", !!yes); }
  function show(part, ms) {
    shown.add(part);
    clearTimeout(timers[part]);
    if (ms) timers[part] = setTimeout(() => hide(part), ms);
    clearTimeout(idleTimer);
  }
  function hide(part) {
    shown.delete(part);
    clearTimeout(timers[part]);
    if (part === "point") { on($("ring"), false); on($("tip"), false); on($("arrow"), false); }
    if (part === "ghost") on($("ghost"), false);
    if (part === "captions") on($("captions"), false);
    if (!shown.size) idleTimer = setTimeout(() => page && page.idle(), 700);
  }

  // ---------------------------------------------------------------- show me where
  function point(m) {
    if (m.op === "end" || !m.rect) return hide("point");
    const r = m.rect, pad = 8;
    const ring = $("ring");
    on(ring, false);
    Object.assign(ring.style, { left: `${r.x - pad}px`, top: `${r.y - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    void ring.offsetWidth; // restart the zoom-in
    on(ring, true);
    const tip = $("tip");
    tip.querySelector(".step").textContent = m.step || "";
    tip.querySelector(".step").style.display = m.step ? "block" : "none";
    tip.querySelector(".name").textContent = m.label || "";
    tip.querySelector(".cap").textContent = m.caption || "";
    tip.querySelector(".cap").style.display = m.caption ? "block" : "none";
    // the tip sits below-right of the control, or wherever there's room
    const W = innerWidth, H = innerHeight, tw = Math.min(340, tip.offsetWidth || 300), th = tip.offsetHeight || 70;
    const below = r.y + r.height + 70 + th < H;
    const right = r.x + r.width / 2 + 40 + tw < W;
    const ax = right ? r.x + r.width + 14 : r.x - 60;
    const ay = below ? r.y + r.height + 14 : r.y - 60;
    const arrow = $("arrow");
    Object.assign(arrow.style, { left: `${ax}px`, top: `${ay}px`, transform: `rotate(${below ? (right ? 270 : 0) : right ? 180 : 90}deg)` });
    Object.assign(tip.style, {
      left: `${Math.max(12, Math.min(W - tw - 12, right ? ax + 36 : ax - tw + 10))}px`,
      top: `${Math.max(12, Math.min(H - th - 12, below ? ay + 36 : ay - th + 10))}px`,
    });
    on(arrow, true);
    on(tip, true);
    show("point", m.hold ? 60000 : 12000);
  }

  // ---------------------------------------------------------------- ghost hands
  let gx = -1, gy = -1;
  function ghost(m) {
    if (m.op === "end") return hide("ghost");
    const g = $("ghost");
    if (m.rect) {
      const x = m.rect.x + m.rect.width / 2, y = m.rect.y + m.rect.height / 2;
      if (gx < 0) { gx = innerWidth / 2; gy = innerHeight * 0.62; g.style.transition = "none"; g.style.transform = `translate(${gx}px, ${gy}px)`; void g.offsetWidth; g.style.transition = ""; }
      trail(gx, gy, x, y);
      g.style.transform = `translate(${x}px, ${y}px)`;
      gx = x; gy = y;
      on(g, true);
      setTimeout(() => { g.classList.remove("click"); void g.offsetWidth; g.classList.add("click"); }, 900);
    }
    show("ghost", 9000);
  }
  function trail(x1, y1, x2, y2) {
    const n = 9;
    for (let i = 1; i < n; i++) {
      const d = document.createElement("span");
      d.className = "trail";
      const t = i / n;
      d.style.left = `${x1 + (x2 - x1) * t}px`;
      d.style.top = `${y1 + (y2 - y1) * t}px`;
      d.style.opacity = "0";
      document.body.appendChild(d);
      setTimeout(() => { d.style.opacity = String(0.15 + 0.4 * t); }, 90 * i);
      setTimeout(() => { d.style.opacity = "0"; d.style.transform = "scale(0.2)"; }, 90 * i + 450);
      setTimeout(() => d.remove(), 90 * i + 1300);
    }
  }

  // ---------------------------------------------------------------- live captions
  let lastLine = "";
  function captions(m) {
    if (m.op === "end") return hide("captions");
    const box = $("captions");
    const line = box.querySelector(".line"), orig = box.querySelector(".orig"), lang = box.querySelector(".lang");
    const text = m.caption || "";
    if (text && text !== lastLine) {
      line.textContent = text;
      line.classList.remove("swap"); void line.offsetWidth; line.classList.add("swap");
      lastLine = text;
    }
    orig.textContent = m.original && m.original !== text ? m.original : "";
    orig.style.display = orig.textContent ? "block" : "none";
    lang.textContent = m.lang || "";
    lang.style.display = m.lang ? "block" : "none";
    on(box, true);
    show("captions", m.op === "show" && !text ? 0 : 15000);
  }

  if (page) {
    page.onShow((m) => {
      if (!m || typeof m !== "object") return;
      if (m.kind === "clear") { ["point", "ghost", "captions"].forEach(hide); return; }
      if (m.kind === "point") point(m);
      else if (m.kind === "ghost") ghost(m);
      else if (m.kind === "captions") captions(m);
    });
  }
})();
