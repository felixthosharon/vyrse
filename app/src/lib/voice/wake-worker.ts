/// <reference lib="webworker" />
/**
 * The phone's wake-word detector, off the UI thread: frames (16 kHz int16, 100 ms) in, "wake" out.
 */
import { WakeDetector, type WakeModel } from "./heed";

let model: WakeModel | null = null;
let detector: WakeDetector | null = null;

type Source = { url: string; headers?: Record<string, string> };

self.onmessage = async (event: MessageEvent<{ type: "init"; sources: Source[] } | { type: "frame"; pcm: Int16Array } | { type: "reset" }>) => {
  const msg = event.data;
  if (msg.type === "init") {
    // The PC's model first (the user's own trained one, if they made it), else the one bundled with the app.
    let lastError = "no model";
    for (const source of msg.sources) {
      try {
        const res = await fetch(source.url, { headers: source.headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        model = (await res.json()) as WakeModel;
        detector = new WakeDetector(model);
        self.postMessage({ type: "ready", source: source.url.includes("/api/") ? "pc" : "bundled", threshold: model.meta.threshold });
        return;
      } catch (err) {
        lastError = String(err);
      }
    }
    self.postMessage({ type: "error", message: lastError });
  } else if (msg.type === "reset") {
    // a fresh 1 s window: nothing heard before the pause counts toward the next detection
    detector = model ? new WakeDetector(model) : null;
  } else if (msg.type === "frame" && detector) {
    const chunk = Float32Array.from(msg.pcm, (v) => v / 32768);
    if (detector.step(chunk).triggered) self.postMessage({ type: "wake" });
  }
};
