import type { SpeechStream, VoiceBackend } from "../vyrse-api";
import type { HermesGateway } from "./gateway";

const LEASE = "vyrse:voice";

/**
 * Hermes' voice plumbing, used by the VYRSE voice controller:
 * - wake word: `wake.start {client_capture}` + `wake.feed` (Hermes runs the "wairz" engine) → `wake.detected`
 * - speech-to-text: `POST /api/audio/transcribe` (Hermes' faster-whisper)
 * - text-to-speech: `/api/audio/speak-stream` WebSocket (Hermes' Kokoro, sentence-streamed PCM)
 * VYRSE owns only the microphone and the speaker.
 */
export class HermesVoice implements VoiceBackend {
  private wakeArmed = false;

  constructor(private readonly gateway: HermesGateway) {
    // A new socket (reconnect, Hermes restart) owns no listener: re-arm.
    gateway.onOnline(() => {
      if (this.wakeArmed) void this.startWake().catch(() => {});
    });
  }

  async startWake(): Promise<{ available: boolean; hint?: string }> {
    this.wakeArmed = true;
    const res = await this.gateway.request<{ listening?: boolean; available?: boolean; hint?: string }>("wake.start", {
      surface: "gui",
      client_capture: true,
    });
    return { available: res.listening !== false && res.available !== false, hint: res.hint };
  }

  async stopWake(): Promise<void> {
    this.wakeArmed = false;
    await this.gateway.request("wake.stop", {}).catch(() => {});
  }

  feedWake(pcm16: Int16Array): void {
    if (!this.wakeArmed || !this.gateway.online) return;
    void this.gateway.request("wake.feed", { pcm: toBase64(pcm16), sample_rate: 16000 }, 5000).catch(() => {});
  }

  onWake(callback: () => void): () => void {
    return this.gateway.on("wake.detected", () => callback());
  }

  async warm(active: boolean): Promise<void> {
    const body = JSON.stringify({ lease: LEASE, active });
    await Promise.allSettled([
      this.gateway.rest("/api/audio/tts-lease", { method: "POST", body }),
      this.gateway.rest("/api/audio/stt-lease", { method: "POST", body }),
    ]);
  }

  async transcribe(wav: Blob): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(wav);
    });
    const res = await this.gateway.rest<{ ok?: boolean; transcript?: string; error?: string }>("/api/audio/transcribe", {
      method: "POST",
      body: JSON.stringify({ data_url: dataUrl, mime_type: "audio/wav" }),
    });
    if (res.ok === false) throw new Error(res.error || "transcription failed");
    return (res.transcript ?? "").trim();
  }

  async micTest(pcm16: Int16Array) {
    const res = await this.gateway.rest<{ wake_max_prob: number; wake_threshold: number; wake_triggered: boolean; saved: string }>(
      "/api/plugins/vyrse/mic-test",
      { method: "POST", body: JSON.stringify({ pcm: toBase64(pcm16) }) },
    );
    return {
      wakeMaxProb: res.wake_max_prob,
      wakeThreshold: res.wake_threshold,
      wakeTriggered: res.wake_triggered,
      savedTo: res.saved,
    };
  }

  speak(): SpeechStream {
    const conn = this.gateway.connection;
    if (!conn) throw new Error("Hermes is not connected");
    const url = `${conn.wsUrl.replace(/\/api\/ws$/, "/api/audio/speak-stream")}?token=${encodeURIComponent(conn.token)}`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const pending: string[] = [];
    let open = false;
    let sampleRate = 24000;
    const audioListeners = new Set<(pcm: Int16Array, rate: number) => void>();
    const endListeners = new Set<(reason: "end" | "error" | "fallback") => void>();
    const end = (reason: "end" | "error" | "fallback") => {
      for (const l of endListeners) l(reason);
      endListeners.clear();
    };
    const send = (msg: object) => {
      if (open && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
      else pending.push(JSON.stringify(msg));
    };
    socket.onopen = () => {
      open = true;
      for (const msg of pending.splice(0)) socket.send(msg);
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data) as { type?: string; sample_rate?: number };
        if (msg.type === "start" && msg.sample_rate) sampleRate = msg.sample_rate;
        else if (msg.type === "end") end("end");
        else if (msg.type === "fallback" || msg.type === "error") end(msg.type === "error" ? "error" : "fallback");
        return;
      }
      const pcm = new Int16Array(event.data as ArrayBuffer);
      for (const l of audioListeners) l(pcm, sampleRate);
    };
    socket.onerror = () => end("error");
    socket.onclose = () => end("end");
    return {
      push: (text) => {
        if (text) send({ text });
      },
      finish: () => send({ done: true }),
      stop: () => {
        send({ stop: true });
        try {
          socket.close();
        } catch {
          // already closed
        }
      },
      onAudio: (cb) => {
        audioListeners.add(cb);
        return () => audioListeners.delete(cb);
      },
      onEnd: (cb) => {
        endListeners.add(cb);
        return () => endListeners.delete(cb);
      },
    };
  }
}

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
