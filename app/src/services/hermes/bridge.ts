/**
 * The Electron preload bridge (`window.vyrse`). The desktop shell owns the Hermes
 * process and hands the renderer only what it needs to talk to Hermes directly.
 *
 * Mirrors desktop/src/shared/backend-types.ts — keep the two in sync.
 */

export type BackendPhase =
  | "locating"
  | "starting"
  | "ready"
  | "restarting"
  | "stopping"
  | "stopped"
  | "failed"
  | "not-installed";

export interface BackendStatus {
  phase: BackendPhase;
  message: string;
  detail?: string;
  attempt?: number;
  logTail?: string[];
}

export interface BackendConnection {
  baseUrl: string;
  wsUrl: string;
  token: string;
  hermesVersion?: string;
}

export interface VyrseBridge {
  backend: {
    getConnection(): Promise<BackendConnection | null>;
    getStatus(): Promise<BackendStatus>;
    restart(): Promise<void>;
    onStatus(callback: (status: BackendStatus) => void): () => void;
  };
  /** present in the desktop app (older shells may lack it) */
  desktop?: {
    pathForFile(file: File): string;
    presence(state: { active: boolean; presence: string; label?: string }): void;
    showMain(): void;
    setTalkShortcut?(accelerator: string | null): Promise<boolean>;
    onTalkShortcut?(callback: () => void): () => void;
    setDictateShortcut?(accelerator: string | null): Promise<boolean>;
    onDictateShortcut?(callback: () => void): () => void;
    typeText?(text: string): Promise<boolean>;
    alexa?(op: string, args?: { text?: string; device?: string }): Promise<unknown>;
    onAlexaStatus?(callback: (status: AlexaStatus) => void): () => void;
    echoSkill?(op: string, args?: Record<string, unknown>): Promise<unknown>;
    onEchoSkillStatus?(callback: (status: EchoSkillStatus) => void): () => void;
    onEchoAsk?(callback: (ask: { id: string; text: string }) => void): () => void;
    echoAnswer?(id: string, text: string): void;
    copyText?(text: string): Promise<boolean>;
    setQuickShortcut?(accelerator: string | null): Promise<boolean>;
    onQuickAsk?(callback: (ask: { id: string; text: string }) => void): () => void;
    quickAnswer?(update: { id: string; text: string; done: boolean; error?: boolean; activity?: string }): void;
    /** draw over the user's screen (rings, the ghost cursor, captions) */
    overlay?(message: OverlayMessage): void;
    /** Esc pressed while VYRSE was driving an app */
    onOverlayStop?(callback: () => void): () => void;
    /** the user clicked inside a "show me where" ring */
    onOverlayClicked?(callback: () => void): () => void;
    /** a photo the phone snapped for the PC */
    onSnap?(callback: (photo: { dataUrl: string; path: string; from: string }) => void): () => void;
  };
}

/** Mirrors OverlayMessage in desktop/src/shared/backend-types.ts. `rect` is in physical screen pixels. */
export interface OverlayMessage {
  kind: "point" | "ghost" | "captions" | "clear";
  op?: "show" | "move" | "end";
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
  caption?: string;
  step?: string;
  original?: string;
  lang?: string;
  /** point: keep the ring until the user clicks inside it */
  hold?: boolean;
}

export interface AlexaStatus {
  state: "off" | "login" | "connecting" | "ready" | "error";
  devices: { serial: string; name: string; family: string; online: boolean }[];
  error?: string;
}

export interface EchoSkillStatus {
  state: "off" | "starting" | "running" | "error";
  enabled: boolean;
  domain: string;
  skillId: string;
  hasToken: boolean;
  linked: boolean;
  endpoint: string;
  error?: string;
}

declare global {
  interface Window {
    vyrse?: VyrseBridge;
  }
}

export function getDesktopBridge(): VyrseBridge | null {
  return typeof window !== "undefined" && window.vyrse?.backend ? window.vyrse : null;
}
