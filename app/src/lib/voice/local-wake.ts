/**
 * The phone's voice backend: everything goes to Hermes on the PC as usual (speech recognition, speech),
 * except the wake word, which runs on the phone (lib/voice/heed.ts in a worker). Hermes allows one wake
 * listener and the PC already holds it, and this way the mic never streams over the Wi-Fi just to listen.
 */
import type { VoiceBackend } from "@/services";
import { loadPairing } from "@/services/phone";

export function withLocalWake(backend: VoiceBackend): VoiceBackend {
  let worker: Worker | null = null;
  let ready: Promise<boolean> | null = null;
  let listening = false;
  const listeners = new Set<() => void>();

  const start = (): Promise<boolean> => {
    if (ready) return ready;
    worker = new Worker(new URL("./wake-worker.ts", import.meta.url), { type: "module" });
    ready = new Promise((resolve) => {
      worker!.onmessage = (e: MessageEvent<{ type: string; message?: string; source?: string; threshold?: number }>) => {
        if (e.data.type === "ready") {
          console.info(`[vyrse:wake] on-device model from ${e.data.source} (threshold ${e.data.threshold})`);
          resolve(true);
        }
        else if (e.data.type === "error") {
          console.warn("[vyrse] wake word unavailable on this phone:", e.data.message);
          resolve(false);
        } else if (e.data.type === "wake" && listening) listeners.forEach((l) => l());
      };
      worker!.onerror = () => resolve(false);
      const pairing = loadPairing();
      const sources = [
        ...(pairing ? [{ url: `${pairing.base}/api/plugins/vyrse/wake-model`, headers: { "X-Hermes-Session-Token": pairing.token } }] : []),
        { url: new URL("./wake/vyrse.json", document.baseURI).href },
      ];
      worker!.postMessage({ type: "init", sources });
    });
    return ready;
  };

  // Everything else (transcribe, speak, warm, micTest) must keep working: those are methods on the
  // backend's class, which a `{ ...backend }` copy silently drops, so the wake overrides sit on an object
  // whose prototype is the backend itself.
  const wrapped = Object.create(backend) as VoiceBackend;
  return Object.assign(wrapped, {
    async startWake() {
      const ok = await start();
      listening = ok;
      if (ok) worker?.postMessage({ type: "reset" });
      return ok ? { available: true } : { available: false, hint: "The wake word couldn't start on this phone." };
    },
    async stopWake() {
      listening = false;
    },
    feedWake(pcm16: Int16Array) {
      if (listening && worker) worker.postMessage({ type: "frame", pcm: pcm16 }, [pcm16.buffer]);
    },
    onWake(callback: () => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  } satisfies Pick<VoiceBackend, "startWake" | "stopWake" | "feedWake" | "onWake">);
}
