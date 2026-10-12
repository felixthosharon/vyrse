import type { BackendConnection, BackendStatus, VyrseBridge } from "./bridge";
import { JsonRpcGatewayClient, type ConnectionState } from "./vendor/json-rpc-gateway";
import type { GatewayEvent, GatewayEventName } from "./vendor/gateway-events";
import type { ServerRequestHandler } from "./vendor/json-rpc-channel";
import { reconnectBackoffDelayMs } from "./vendor/reconnect-backoff";

/**
 * What the UI shows about the link to Hermes. `backend` is the desktop shell's view of
 * the process; `socket` is this renderer's WebSocket.
 */
export type LinkPhase = "starting" | "connecting" | "online" | "reconnecting" | "offline" | "failed" | "not-installed";

export interface LinkState {
  phase: LinkPhase;
  message: string;
  detail?: string;
  logTail?: string[];
  hermesVersion?: string;
}

type LinkListener = (state: LinkState) => void;

/**
 * One long-lived connection to `hermes serve`.
 *
 * The desktop shell may restart Hermes (new port, new token), so the gateway follows
 * backend status from the bridge and re-dials whenever a fresh connection is published.
 * Socket drops while the backend is still up are retried with Hermes' own backoff policy;
 * the vendored client replays missed session events (`session.events.since`) on reconnect.
 */
export class HermesGateway {
  readonly client = new JsonRpcGatewayClient({ requestIdPrefix: "vyrse" });
  private conn: BackendConnection | null = null;
  private link: LinkState = { phase: "starting", message: "Starting Hermes" };
  private listeners = new Set<LinkListener>();
  private readyListeners = new Set<() => void>();
  private backendChangeListeners = new Set<() => void>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private backendReady = false;
  private dialing = false;

  constructor(private readonly bridge: VyrseBridge) {
    this.client.onState((state) => this.onSocketState(state));
    bridge.backend.onStatus((status) => void this.onBackendStatus(status));
    void bridge.backend.getStatus().then((status) => this.onBackendStatus(status));
    // Coming back to the app (the phone woke up, the Wi-Fi returned): redial now rather than waiting
    // out a backoff that grew while the device slept.
    const wake = () => {
      if (document.visibilityState !== "visible" || this.online || !this.conn || !this.backendReady) return;
      this.reconnectAttempt = 0;
      void this.dial();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
  }

  get state(): LinkState {
    return this.link;
  }

  get connection(): BackendConnection | null {
    return this.conn;
  }

  get online(): boolean {
    return this.link.phase === "online";
  }

  subscribe(listener: LinkListener): () => void {
    this.listeners.add(listener);
    listener(this.link);
    return () => this.listeners.delete(listener);
  }

  /** Runs every time the socket (re)opens — callers re-sync state that may have changed. */
  onOnline(listener: () => void): () => void {
    this.readyListeners.add(listener);
    if (this.online) listener();
    return () => this.readyListeners.delete(listener);
  }

  /**
   * Runs when Hermes itself was restarted (new port/token): live sessions from the old
   * process are gone and must be resumed from the session store again.
   */
  onBackendChanged(listener: () => void): () => void {
    this.backendChangeListeners.add(listener);
    return () => this.backendChangeListeners.delete(listener);
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.client.request<T>(method, params, timeoutMs);
  }

  on<K extends GatewayEventName>(type: K, handler: (event: GatewayEvent<K>) => void): () => void {
    return this.client.on(type, handler);
  }

  onAny(handler: (event: GatewayEvent) => void): () => void {
    return this.client.onAny(handler);
  }

  onRequest(handler: ServerRequestHandler): () => void {
    return this.client.onRequest(handler);
  }

  /** Authenticated REST call to the same backend (skills, memory, audio, local models). */
  async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const conn = this.conn;
    if (!conn) throw new Error("Hermes is not connected");
    const res = await fetch(`${conn.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Hermes-Session-Token": conn.token,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { detail?: unknown };
        if (body.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch {
        // non-JSON error body
      }
      throw new Error(`${path}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  restartBackend(): Promise<void> {
    return this.bridge.backend.restart();
  }

  private async onBackendStatus(status: BackendStatus): Promise<void> {
    this.backendReady = status.phase === "ready";
    if (status.phase === "ready") {
      const conn = await this.bridge.backend.getConnection();
      if (!conn) return;
      const replaced = this.conn !== null && (this.conn.wsUrl !== conn.wsUrl || this.conn.token !== conn.token);
      this.conn = conn;
      if (replaced) {
        this.client.invalidate("Hermes restarted");
        for (const listener of this.backendChangeListeners) listener();
      }
      if (replaced || !this.online) void this.dial();
      return;
    }
    // Backend not ready: the socket (if any) is about to die; show the shell's view.
    this.cancelReconnect();
    const phase: LinkPhase =
      status.phase === "failed"
        ? "failed"
        : status.phase === "not-installed"
          ? "not-installed"
          : status.phase === "restarting"
            ? "reconnecting"
            : status.phase === "stopped" || status.phase === "stopping"
              ? "offline"
              : "starting";
    this.setLink({ phase, message: status.message, detail: status.detail, logTail: status.logTail });
  }

  private async dial(): Promise<void> {
    const conn = this.conn;
    if (!conn || this.dialing) return;
    this.dialing = true;
    this.cancelReconnect();
    this.setLink({ phase: this.reconnectAttempt ? "reconnecting" : "connecting", message: "Connecting to Hermes" });
    try {
      await this.client.connect(`${conn.wsUrl}?token=${encodeURIComponent(conn.token)}`);
    } catch {
      // onSocketState schedules the retry
    } finally {
      this.dialing = false;
    }
  }

  private onSocketState(state: ConnectionState): void {
    if (state === "open") {
      this.reconnectAttempt = 0;
      this.setLink({ phase: "online", message: "Connected to Hermes", hermesVersion: this.conn?.hermesVersion });
      for (const listener of this.readyListeners) listener();
      return;
    }
    if ((state === "closed" || state === "error") && this.backendReady && this.conn) {
      this.setLink({ phase: "reconnecting", message: "Reconnecting to Hermes" });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = reconnectBackoffDelayMs(this.reconnectAttempt++);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.dial();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setLink(state: LinkState): void {
    this.link = state;
    for (const listener of this.listeners) listener(state);
  }
}
