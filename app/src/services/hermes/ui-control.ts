import type { WorkspaceUpdate } from "./workspace-interact";
import type { Artifact, Settings } from "@/lib/vyrse/types";
import type { AlexaOp, PhoneAction, ReasoningLevel, UiCommand, VoiceMonkeyView, WakeTrainStatus } from "../vyrse-api";
import type { HermesGateway } from "./gateway";
import { parseArtifact } from "./workspace-artifact";

const PANELS = new Set(["settings", "history", "transcript", "none"]);
const MODES = new Set(["assistant", "private", "gaming"]);
const REASONING = new Set(["none", "low", "medium", "high"]);
const ALEXA_OPS = new Set(["status", "command", "speak", "announce"]);
const PHONE_ACTIONS = new Set([
  "battery", "flashlight", "find", "media", "volume", "notifications", "notify", "status",
  "screen", "screenshot", "tap", "long_press", "type", "swipe", "key", "open_app", "open_url", "send_file",
]);

/**
 * Validates one `vyrse.ui` event payload (emitted by the vyrse plugin's `vyrse_ui` tool)
 * into a typed command, or null. The plugin validates too; this is the UI's own guard —
 * nothing from the backend reaches state without passing here.
 */
export function parseUiCommand(payload: unknown): UiCommand | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  switch (p["action"]) {
    case "prefs": {
      const prefs = p["prefs"];
      return prefs && typeof prefs === "object" ? { action: "prefs", prefs: prefs as Partial<Settings> } : null;
    }
    case "open":
      return PANELS.has(String(p["panel"])) ? { action: "open", panel: p["panel"] as "settings" | "history" | "transcript" | "none" } : null;
    case "new_conversation":
      return { action: "new_conversation" };
    case "open_conversation":
      return typeof p["query"] === "string" && p["query"] ? { action: "open_conversation", query: p["query"] } : null;
    case "mode":
      return MODES.has(String(p["mode"])) ? { action: "mode", mode: p["mode"] as Settings["mode"] } : null;
    case "model":
      return typeof p["model"] === "string" && p["model"]
        ? { action: "model", model: p["model"], provider: typeof p["provider"] === "string" ? p["provider"] : "" }
        : null;
    case "reasoning":
      return REASONING.has(String(p["level"])) ? { action: "reasoning", level: p["level"] as ReasoningLevel } : null;
    case "notify":
      return typeof p["text"] === "string" && p["text"] ? { action: "notify", text: p["text"].slice(0, 200) } : null;
    case "overlay": {
      const kind = p["kind"];
      if (kind !== "point" && kind !== "ghost" && kind !== "clear") return null;
      const r = p["rect"] as Record<string, unknown> | undefined;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
      const rect = r && n(r["x"]) !== null && n(r["y"]) !== null && (n(r["width"]) ?? 0) > 0 && (n(r["height"]) ?? 0) > 0
        ? { x: n(r["x"])!, y: n(r["y"])!, width: n(r["width"])!, height: n(r["height"])! }
        : undefined;
      const op = p["op"] === "end" ? "end" : p["op"] === "move" ? "move" : "show";
      const text = (k: string, max: number) => (typeof p[k] === "string" && p[k] ? { [k]: (p[k] as string).slice(0, max) } : {});
      return { action: "overlay", message: { kind, op, ...(rect ? { rect } : {}), ...text("label", 80), ...text("caption", 140), ...text("step", 20), ...(p["hold"] === true ? { hold: true } : {}) } };
    }
    case "captions":
      return p["op"] === "start" || p["op"] === "stop"
        ? { action: "captions", op: p["op"], to: typeof p["to"] === "string" && /^[a-z]{2,3}$/.test(p["to"]) ? p["to"] : "en" }
        : null;
    case "record":
      return p["op"] === "start" || p["op"] === "stop"
        ? { action: "record", op: p["op"], title: typeof p["title"] === "string" ? p["title"].slice(0, 60) : "" }
        : null;
    case "alert":
      return typeof p["text"] === "string" && p["text"]
        ? { action: "alert", title: typeof p["title"] === "string" ? p["title"].slice(0, 80) : "", text: p["text"].slice(0, 240) }
        : null;
    case "workspace": {
      const layout = ["compact", "split", "focus"].includes(String(p["layout"])) ? (p["layout"] as "compact" | "split" | "focus") : undefined;
      const session = typeof p["session"] === "string" && p["session"] ? { session: p["session"].slice(0, 80) } : {};
      if (p["op"] === "show") {
        const artifact = parseArtifact(p["artifact"]);
        return artifact
          ? { action: "workspace", op: "show", artifact, ...(layout && layout !== "compact" ? { layout } : {}), ...(p["focus"] === true ? { focus: true } : {}), ...session }
          : null;
      }
      if (p["op"] === "focus") return { action: "workspace", op: "focus", id: typeof p["id"] === "string" ? p["id"].slice(0, 48) : "", ...session };
      if (p["op"] === "remove" && typeof p["id"] === "string") return { action: "workspace", op: "remove", id: p["id"].slice(0, 48), ...session };
      if (p["op"] === "clear") return { action: "workspace", op: "clear", ...session };
      if (p["op"] === "layout" && layout) return { action: "workspace", op: "layout", layout };
      return null;
    }
    case "confirm": {
      const choices = Array.isArray(p["choices"]) ? p["choices"].filter((c): c is string => typeof c === "string").slice(0, 4) : [];
      return typeof p["id"] === "string" && typeof p["question"] === "string" && choices.length
        ? { action: "confirm", id: p["id"], question: p["question"].slice(0, 400), choices }
        : null;
    }
    case "desktop_call": {
      const args = p["args"] && typeof p["args"] === "object" ? (p["args"] as Record<string, unknown>) : {};
      const clean: { text?: string; device?: string } = {};
      if (typeof args["text"] === "string") clean.text = args["text"].slice(0, 500);
      if (typeof args["device"] === "string") clean.device = args["device"].slice(0, 80);
      if (typeof p["id"] !== "string") return null;
      if (p["target"] === "phone" && PHONE_ACTIONS.has(String(p["op"]))) {
        // Plain short values only (state, command, level, title, text, limit).
        const phoneArgs: Record<string, string | number> = {};
        for (const [k, v] of Object.entries(args).slice(0, 8))
          if (typeof v === "string") phoneArgs[k.slice(0, 20)] = v.slice(0, 500);
          else if (typeof v === "number" && Number.isFinite(v)) phoneArgs[k.slice(0, 20)] = v;
        return { action: "desktop_call", id: p["id"].slice(0, 40), target: "phone", op: p["op"] as PhoneAction, args: phoneArgs };
      }
      return p["target"] === "alexa" && ALEXA_OPS.has(String(p["op"]))
        ? { action: "desktop_call", id: p["id"].slice(0, 40), target: "alexa", op: p["op"] as AlexaOp, args: clean }
        : null;
    }
    default:
      return null;
  }
}

/** Interface preferences live in the vyrse plugin's store, shared with Hermes' `vyrse_ui` tool. */
export class HermesUiControl {
  constructor(private readonly gateway: HermesGateway) {}

  onCommand(callback: (command: UiCommand) => void): () => void {
    return this.gateway.onAny((event) => {
      if ((event.type as string) !== "vyrse.ui" || event.replayed) return;
      const command = parseUiCommand(event.payload);
      if (command) callback(command);
      else console.warn("[vyrse] ignored malformed vyrse.ui event", event.payload);
    });
  }

  /** the user clicked the ringed control: a walkthrough moves to its next step */
  async pointClicked(): Promise<void> {
    await this.gateway.rest("/api/plugins/vyrse/point/clicked", { method: "POST" });
  }

  /** Esc while VYRSE drives: it stops clicking at once */
  async pointStop(): Promise<void> {
    await this.gateway.rest("/api/plugins/vyrse/point/stop", { method: "POST" });
  }

  async captionsWarm(): Promise<void> {
    await this.gateway.rest("/api/plugins/vyrse/captions/warm", { method: "POST" });
  }

  async captionsChunk(pcm: Int16Array, to: string, session: string): Promise<{ text: string; original?: string; lang?: string }> {
    return this.gateway.rest(`/api/plugins/vyrse/captions/chunk?to=${encodeURIComponent(to)}&session=${encodeURIComponent(session)}`, {
      method: "POST",
      body: new Blob([pcm.buffer as ArrayBuffer]),
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  async uploadRecording(audio: Blob, title: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    const ext = audio.type.includes("ogg") ? ".ogg" : audio.type.includes("mp4") ? ".m4a" : ".webm";
    return this.gateway.rest(`/api/plugins/vyrse/notes/upload?title=${encodeURIComponent(title)}&ext=${ext}`, {
      method: "POST",
      body: audio,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  async answerConfirm(id: string, choice: string | null): Promise<void> {
    await this.gateway.rest(`/api/plugins/vyrse/confirm/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ choice }),
    });
  }

  async answerDesktopCall(id: string, result: unknown): Promise<void> {
    await this.gateway.rest(`/api/plugins/vyrse/desktop-result/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ result }),
    });
  }

  async getVoiceMonkey(): Promise<VoiceMonkeyView> {
    return this.gateway.rest<VoiceMonkeyView>("/api/plugins/vyrse/voicemonkey");
  }

  async setVoiceMonkey(patch: { token?: string; speaker?: string; routines?: Record<string, string> }): Promise<VoiceMonkeyView> {
    return this.gateway.rest<VoiceMonkeyView>("/api/plugins/vyrse/voicemonkey", { method: "PUT", body: JSON.stringify(patch) });
  }

  async loadWorkspace(conversationId: string): Promise<Artifact[]> {
    const res = await this.gateway.rest<{ items?: unknown[] }>(`/api/plugins/vyrse/workspace/${encodeURIComponent(conversationId)}`);
    return (res.items ?? []).map(parseArtifact).filter((a): a is Artifact => a !== null);
  }

  async removeWorkspaceItem(conversationId: string, id: string): Promise<void> {
    await this.gateway.rest(`/api/plugins/vyrse/workspace/${encodeURIComponent(conversationId)}/remove`, {
      method: "POST",
      body: JSON.stringify({ id }),
    });
  }

  async clearWorkspace(conversationId: string): Promise<void> {
    await this.gateway.rest(`/api/plugins/vyrse/workspace/${encodeURIComponent(conversationId)}/clear`, { method: "POST" });
  }

  async checkWorkspaceItem(conversationId: string, id: string, index: number, done: boolean): Promise<void> {
    await this.gateway.rest(`/api/plugins/vyrse/workspace/${encodeURIComponent(conversationId)}/check`, {
      method: "POST",
      body: JSON.stringify({ id, index, done }),
    });
  }

  async fileIndex(refresh = false): Promise<{ files: number; built_at: number | null; building: boolean }> {
    return this.gateway.rest("/api/plugins/vyrse/files/index", refresh ? { method: "POST" } : {});
  }

  async updateWorkspaceItem(conversationId: string, id: string, update: WorkspaceUpdate): Promise<void> {
    await this.gateway.rest(`/api/plugins/vyrse/workspace/${encodeURIComponent(conversationId)}/update`, {
      method: "POST",
      body: JSON.stringify({ id, op: update.op, args: update.args }),
    });
  }

  async loadPrefs(): Promise<Partial<Settings>> {
    const res = await this.gateway.rest<{ prefs?: Partial<Settings> }>("/api/plugins/vyrse/state");
    return res.prefs ?? {};
  }

  async wakeTrain(op: "status" | "start" | "clear"): Promise<WakeTrainStatus> {
    const path = op === "status" ? "/api/plugins/vyrse/wake-train" : `/api/plugins/vyrse/wake-train/${op}`;
    const res = await this.gateway.rest<WakeTrainStatus & { takes?: WakeTrainStatus["takes"] }>(path, { method: op === "status" ? "GET" : "POST" });
    return res;
  }

  async wakeTrainSample(kind: "wake" | "other", pcm: Int16Array): Promise<WakeTrainStatus> {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const res = await this.gateway.rest<{ takes: WakeTrainStatus["takes"] }>("/api/plugins/vyrse/wake-train/sample", {
      method: "POST",
      body: JSON.stringify({ kind, pcm: btoa(bin) }),
    });
    return { takes: res.takes };
  }

  async savePrefs(patch: Partial<Settings>): Promise<void> {
    await this.gateway.rest("/api/plugins/vyrse/state", { method: "PATCH", body: JSON.stringify({ prefs: patch }) });
  }

  /** Gaming mode: free the GPU by unloading every loaded local model (reloads on next message). */
  async unloadLocalModels(): Promise<number> {
    const status = await this.gateway.rest<{ loaded_models?: Record<string, string> }>("/api/local-models/status");
    const loaded = Object.entries(status.loaded_models ?? {}).filter(([, s]) => s === "loaded" || s === "loading");
    await Promise.all(
      loaded.map(([model_id]) =>
        this.gateway.rest("/api/local-models/eject", { method: "POST", body: JSON.stringify({ model_id }) }),
      ),
    );
    return loaded.length;
  }
}
