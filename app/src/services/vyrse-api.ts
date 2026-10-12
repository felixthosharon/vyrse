import type { Artifact, Message, PresentationMode, Settings } from "@/lib/vyrse/types";

/**
 * The Vyrse renderer/backend boundary.
 *
 * Everything the UI knows about "intelligence" arrives through this contract.
 * The Hermes adapter (services/hermes) is the real implementation: Hermes Agent
 * owns the agent loop, tools, sessions, approvals and models. The mock adapter
 * drives UI development without a backend. No UI component may import an
 * adapter directly — they consume the resolved `vyrseApi` from `./index`.
 */

export type StreamStatus = "thinking" | "working" | "speaking";

export type StreamEvent =
  /** presence/status transition, optionally with a short provenance line */
  | { type: "status"; status: StreamStatus; meta?: string }
  /** incremental reply text; the UI must render chunks as they arrive */
  | { type: "text"; delta: string }
  /** the model is reasoning before it answers (content is not shown verbatim) */
  | { type: "reasoning"; delta: string }
  /** a tool call is being prepared, has started, or has finished */
  | {
      type: "tool";
      phase: "generating" | "start" | "end";
      name: string;
      id?: string;
      /** short human label, e.g. the command or path the tool acts on */
      label?: string;
      durationS?: number;
      summary?: string;
    }
  /** a short provenance/status line from Hermes ("compressing context…") */
  | { type: "notice"; text: string }
  /** structured content attached to the current response */
  | { type: "artifact"; artifact: Artifact }
  /**
   * A *semantic* workspace request — never dimensions, CSS or markup. The
   * frontend owns all sizing and may ignore the request entirely.
   */
  | { type: "presentation"; mode: PresentationMode }
  /** terminal success (or user interruption, with `interrupted`) */
  | { type: "done"; interrupted?: boolean }
  /** terminal failure; `detail` is developer-facing only */
  | { type: "error"; message: string; detail?: string };

export interface TurnRequest {
  prompt: string;
  conversationId?: string;
  /** true when the prompt came from speech (Hermes gets the voice context) */
  voice?: boolean;
  /** reasoning level for this turn; applied to the Hermes session only when it changes */
  reasoning?: ReasoningLevel;
  /** absolute paths of files the user attached; Hermes gets them as @file references */
  attachments?: string[];
}

/** A reminder or routine (a Hermes cron job). */
export interface Reminder {
  id: string;
  name: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  paused: boolean;
  /** a one-time reminder that already ran */
  done: boolean;
}

/** A reminder/routine that just ran; `text` is what Hermes produced for the user. */
export interface FiredReminder {
  jobId: string;
  name: string;
  text: string;
  at: number;
  ok: boolean;
}

export type ApprovalChoice = "once" | "session" | "always" | "deny";

/** Hermes asks before a flagged (dangerous) action; the agent is paused until answered. */
export interface ApprovalPrompt {
  id: string;
  conversationId: string | null;
  command: string;
  description: string;
  toolName?: string;
  choices: ApprovalChoice[];
}

/** Hermes' clarify tool: the agent asks the user 1–5 questions mid-task. */
export interface ClarifyPrompt {
  id: string;
  conversationId: string | null;
  questions: { qid: string; question: string; choices?: string[]; multiSelect?: boolean }[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  preview?: string;
  messageCount?: number;
  source?: string;
}

export interface ModelChoice {
  provider: string;
  providerLabel: string;
  model: string;
  local: boolean;
}

export type ReasoningLevel = "none" | "low" | "medium" | "high";

/** Agent settings owned by Hermes (VYRSE only displays and edits them). */
export interface AgentSettings {
  model: string;
  provider: string;
  models: ModelChoice[];
  reasoning: ReasoningLevel;
  approvalMode: "manual" | "smart" | "off";
  memoryEnabled: boolean;
  /** bytes currently stored in Hermes' built-in memory files */
  memoryBytes: number;
  /** local speech-recognition model (faster-whisper), e.g. "base.en" */
  sttModel: string;
}

/** One streamed spoken reply (Hermes speak-stream). */
export interface SpeechStream {
  push(text: string): void;
  finish(): void;
  stop(): void;
  onAudio(callback: (pcm: Int16Array, sampleRate: number) => void): () => void;
  onEnd(callback: (reason: "end" | "error" | "fallback") => void): () => void;
}

/** Hermes' voice services; VYRSE owns only the microphone and the speaker. */
export interface VoiceBackend {
  startWake(): Promise<{ available: boolean; hint?: string }>;
  stopWake(): Promise<void>;
  feedWake(pcm16: Int16Array): void;
  onWake(callback: () => void): () => void;
  /** pre-load (true) or release (false) Hermes' speech models */
  warm(active: boolean): Promise<void>;
  transcribe(wav: Blob): Promise<string>;
  speak(): SpeechStream;
  /** score 16 kHz PCM with the wake detector; Hermes saves it for diagnosis */
  micTest(pcm16: Int16Array): Promise<{ wakeMaxProb: number; wakeThreshold: number; wakeTriggered: boolean; savedTo: string }>;
}

/** A skill installed in Hermes. */
export interface InstalledSkill {
  name: string;
  description: string;
  category?: string;
  enabled: boolean;
  /** "bundled" ships with Hermes; others came from the hub or were written by the agent */
  provenance?: string;
}

/** A skill found on the Skills Hub (not necessarily installed). */
export interface HubSkill {
  name: string;
  description: string;
  source: string;
  identifier: string;
  /** "builtin" | "trusted" | "community" — Hermes' trust level for the source */
  trust: string;
  installed: boolean;
}

/**
 * A request from Hermes (its `vyrse_ui` tool) to change the interface. The UI runs each one
 * through the same functions a human click uses — never DOM manipulation.
 */
export interface WakeTrainStatus {
  phase?: "idle" | "preparing" | "training" | "checking" | "done" | "failed";
  message?: string;
  running?: boolean;
  takes: { wake: number; other: number };
  result?: { held_out_caught: number; held_out: number; false_triggers: number; speech_minutes: number };
}

export type AlexaOp = "status" | "command" | "speak" | "announce";
/** What Hermes' vyrse_phone tool can ask of the paired phone (run by the app's native part there). */
export type PhoneAction =
  | "battery" | "flashlight" | "find" | "media" | "volume" | "notifications" | "notify" | "status"
  | "screen" | "screenshot" | "tap" | "long_press" | "type" | "swipe" | "key" | "open_app" | "open_url";

/** Voice Monkey setup as the UI sees it (the token itself never comes back). */
export interface VoiceMonkeyView {
  configured: boolean;
  speaker: string;
  routines: Record<string, string>;
}

export type UiCommand =
  | { action: "prefs"; prefs: Partial<Settings> }
  | { action: "open"; panel: "settings" | "history" | "transcript" | "none" }
  | { action: "new_conversation" }
  | { action: "open_conversation"; query: string }
  | { action: "mode"; mode: Settings["mode"] }
  | { action: "model"; model: string; provider: string }
  | { action: "reasoning"; level: ReasoningLevel }
  | { action: "notify"; text: string }
  /** Something VYRSE was watching for happened (a watch crossing its line): sound, card, said aloud. */
  | { action: "alert"; title: string; text: string }
  /** a plugin tool asks the user to choose (e.g. "install this skill?"); answered via ui.answerConfirm */
  | { action: "confirm"; id: string; question: string; choices: string[] }
  /** a plugin tool needs the desktop app (e.g. Alexa); the result goes back via ui.answerDesktopCall */
  | { action: "desktop_call"; id: string; target: "alexa"; op: AlexaOp; args: { text?: string; device?: string } }
  | { action: "desktop_call"; id: string; target: "phone"; op: PhoneAction; args: Record<string, string | number> }
  /** Hermes' vyrse_workspace tool: put typed content in the workspace panel */
  | { action: "workspace"; op: "show"; artifact: Artifact; layout?: PresentationMode; focus?: boolean; session?: string }
  | { action: "workspace"; op: "focus"; id: string; session?: string }
  | { action: "workspace"; op: "remove"; id: string; session?: string }
  | { action: "workspace"; op: "clear"; session?: string }
  | { action: "workspace"; op: "layout"; layout: PresentationMode };

/** Connection to the agent backend as the UI presents it. */
export interface LinkStatus {
  phase: "starting" | "connecting" | "online" | "reconnecting" | "offline" | "failed" | "not-installed";
  message: string;
  detail?: string;
  logTail?: string[];
  hermesVersion?: string;
}

export interface VyrseApi {
  /** identifier for the debug layer, e.g. "mock" | "hermes" */
  readonly id: string;
  /** true when a real backend is behind this adapter */
  readonly live: boolean;
  /**
   * Streams a single assistant turn. Implementations MUST:
   *  - respect `signal` and stop promptly on abort (interrupting the agent)
   *  - emit exactly one terminal event (`done` or `error`)
   *  - never throw for expected failures (emit `error` instead)
   */
  stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;

  /** Pre-load the model's prompt cache in the background (no visible conversation). */
  warmUp?(): Promise<void>;

  /** Connection state; absent for the mock (always "online"). */
  link?: {
    subscribe(callback: (status: LinkStatus) => void): () => void;
    restart(): Promise<void>;
  };

  conversations?: {
    list(): Promise<ConversationSummary[]>;
    /** Creates an empty conversation (a Hermes session) and returns its summary. */
    create(): Promise<ConversationSummary>;
    /** Loads the full transcript (resuming the Hermes session). */
    open(id: string): Promise<{ summary: ConversationSummary; messages: Message[] }>;
    rename(id: string, title: string): Promise<void>;
    /** Drops the last exchange from the backend's history (retry / edit last message). */
    undo?(id: string): Promise<number>;
    delete(id: string): Promise<void>;
    /** Fires when the backend's session list changed (title set, new session, deletion). */
    onChanged(callback: () => void): () => void;
  };

  approvals?: {
    onRequest(callback: (prompt: ApprovalPrompt) => void): () => void;
    /** The backend withdrew a prompt (timeout, interrupt, answered elsewhere). */
    onCancel(callback: (id: string) => void): () => void;
    respond(id: string, choice: ApprovalChoice): void;
  };

  agent?: {
    load(): Promise<AgentSettings>;
    /** `conversationId` (if open in Hermes) also switches that live session immediately. */
    setModel(choice: ModelChoice, conversationId?: string | null): Promise<void>;
    setReasoning(level: ReasoningLevel): Promise<void>;
    setApprovalMode(mode: AgentSettings["approvalMode"]): Promise<void>;
    setMemoryEnabled(enabled: boolean): Promise<void>;
    setSttModel(model: string): Promise<void>;
    /** Fires when Hermes reports the active model changed (any client, any cause). */
    onModelChanged(callback: (model: { model: string; provider: string }) => void): () => void;
  };

  /** Interface control by Hermes and the shared interface-preference store (vyrse plugin). */
  ui?: {
    onCommand(callback: (command: UiCommand) => void): () => void;
    loadPrefs(): Promise<Partial<Settings>>;
    savePrefs(patch: Partial<Settings>): Promise<void>;
    /** Teach it my voice: in-app wake-word training (vyrse plugin) */
    wakeTrain(op: "status" | "start" | "clear"): Promise<WakeTrainStatus>;
    wakeTrainSample(kind: "wake" | "other", pcm: Int16Array): Promise<WakeTrainStatus>;
    unloadLocalModels(): Promise<number>;
    answerConfirm(id: string, choice: string | null): Promise<void>;
    answerDesktopCall(id: string, result: unknown): Promise<void>;
    getVoiceMonkey(): Promise<VoiceMonkeyView>;
    /** token "" removes the setup; omitted fields stay as they are */
    setVoiceMonkey(patch: { token?: string; speaker?: string; routines?: Record<string, string> }): Promise<VoiceMonkeyView>;
    /** a conversation's saved workspace board, newest first */
    loadWorkspace(conversationId: string): Promise<Artifact[]>;
    removeWorkspaceItem(conversationId: string, id: string): Promise<void>;
    clearWorkspace(conversationId: string): Promise<void>;
    /** the user ticked a checklist line */
    checkWorkspaceItem(conversationId: string, id: string, index: number, done: boolean): Promise<void>;
  };

  voice?: VoiceBackend;

  /** Reminders and routines: Hermes cron jobs, fired by the scheduler the vyrse plugin runs. */
  reminders?: {
    list(): Promise<Reminder[]>;
    setPaused(id: string, paused: boolean): Promise<void>;
    remove(id: string): Promise<void>;
    /** results written after `since` (unix seconds); `now` is the server clock for the next call */
    fired(since: number): Promise<{ now: number; fired: FiredReminder[] }>;
  };

  /** Hermes' skill system; VYRSE only manages it, never runs skills itself. */
  skills?: {
    list(): Promise<InstalledSkill[]>;
    setEnabled(name: string, enabled: boolean): Promise<void>;
    content(name: string): Promise<string>;
    search(query: string): Promise<HubSkill[]>;
    install(identifier: string): Promise<void>;
    uninstall(name: string): Promise<void>;
  };

  clarify?: {
    onRequest(callback: (prompt: ClarifyPrompt) => void): () => void;
    onCancel(callback: (id: string) => void): () => void;
    /** `null` declines every question (Hermes treats it as cancel-all). */
    respond(id: string, answers: Record<string, string> | null): void;
  };
}

export class VyrseStreamError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "VyrseStreamError";
  }
}
