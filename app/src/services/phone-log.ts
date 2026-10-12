/**
 * Phone app → PC log (userData/phone.log on the PC, via the bridge): warnings, errors, crashes and a
 * startup checkup, so problems that only happen on the phone can be read and fixed from the PC.
 * Only VYRSE's own messages; nothing from other apps.
 */
import type { PhonePairing } from "./phone";

type Entry = { t: number; level: string; msg: string };

export function installPhoneLog(p: PhonePairing): (level: string, msg: string) => void {
  const queue: Entry[] = [];
  let timer = 0;
  const flush = () => {
    timer = 0;
    const entries = queue.splice(0, 200);
    if (!entries.length) return;
    void fetch(`${p.base}/phone/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hermes-Session-Token": p.token },
      body: JSON.stringify({ entries }),
      keepalive: true,
    }).catch(() => {
      // PC unreachable: keep the newest few for next time.
      queue.unshift(...entries.slice(-50));
    });
  };
  const push = (level: string, msg: string) => {
    queue.push({ t: Date.now(), level, msg: msg.slice(0, 2000) });
    if (queue.length > 400) queue.splice(0, queue.length - 400);
    if (!timer) timer = window.setTimeout(flush, 1500);
  };
  const text = (args: unknown[]) =>
    args
      .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : safeJson(a)))
      .join(" ");
  for (const level of ["warn", "error", "info"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      push(level, text(args));
    };
  }
  window.addEventListener("error", (e) => push("crash", `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => push("crash", `unhandled: ${text([e.reason])}`));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  push(
    "info",
    `app start · ${navigator.userAgent} · screen ${screen.width}x${screen.height}@${devicePixelRatio} · ` +
      `OffscreenCanvas=${"OffscreenCanvas" in window} AudioWorklet=${"AudioWorkletNode" in window} ` +
      `cores=${navigator.hardwareConcurrency} mem=${(navigator as { deviceMemory?: number }).deviceMemory ?? "?"}GB`,
  );
  return push;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
