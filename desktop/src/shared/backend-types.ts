// Types shared by the Electron main process, the preload bridge and the renderer.
// Keep this file free of runtime imports: the sandboxed preload can only use it for types.

export type BackendPhase =
  | 'locating' // finding the Hermes install
  | 'starting' // `hermes serve` spawned, waiting for readiness
  | 'ready' // health + WebSocket probe passed; connection info is valid
  | 'restarting' // backend exited unexpectedly; waiting to respawn
  | 'stopping'
  | 'stopped'
  | 'failed' // gave up (crash loop / start timeout); `detail` + `logTail` explain why
  | 'not-installed' // no Hermes install found

export interface BackendStatus {
  phase: BackendPhase
  message: string
  detail?: string
  attempt?: number
  logTail?: string[]
}

export interface BackendConnection {
  /** http://127.0.0.1:<port> — REST base. */
  baseUrl: string
  /** ws://127.0.0.1:<port>/api/ws — JSON-RPC gateway (append `?token=`). */
  wsUrl: string
  /** Per-launch session token; send as `X-Hermes-Session-Token` (REST) or `?token=` (WS). */
  token: string
  hermesVersion?: string
}

export const IPC_CHANNELS = {
  getConnection: 'vyrse:backend:get-connection',
  getStatus: 'vyrse:backend:get-status',
  restart: 'vyrse:backend:restart',
  status: 'vyrse:backend:status',
  presence: 'vyrse:presence',
  orbState: 'vyrse:orb-state',
  showMain: 'vyrse:show-main',
  orbInteractive: 'vyrse:orb-interactive',
  setTalkShortcut: 'vyrse:set-talk-shortcut',
  talkShortcut: 'vyrse:talk-shortcut',
  setDictateShortcut: 'vyrse:set-dictate-shortcut',
  dictateShortcut: 'vyrse:dictate-shortcut',
  typeText: 'vyrse:type-text',
  alexa: 'vyrse:alexa',
  alexaStatus: 'vyrse:alexa-status',
  echoSkill: 'vyrse:echo-skill',
  echoSkillStatus: 'vyrse:echo-skill-status',
  echoAsk: 'vyrse:echo-ask',
  echoAnswer: 'vyrse:echo-answer',
  copyText: 'vyrse:copy-text',
  setQuickShortcut: 'vyrse:set-quick-shortcut',
  quickAsk: 'vyrse:quick-ask',
  quickForward: 'vyrse:quick-forward',
  quickAnswer: 'vyrse:quick-answer',
  quickUpdate: 'vyrse:quick-update',
  quickResize: 'vyrse:quick-resize',
  quickShow: 'vyrse:quick-show',
  quickHide: 'vyrse:quick-hide',
  quickHideRequest: 'vyrse:quick-hide-request',
  quickOpenMain: 'vyrse:quick-open-main',
  phone: 'vyrse:phone',
  phoneStatus: 'vyrse:phone-status',
} as const

/** What the floating orb shows; sent by the main window's renderer. */
export interface OrbState {
  /** something is happening (listening, thinking, speaking, a reminder) */
  active: boolean
  presence: string
  label?: string
}

export interface AlexaDevice {
  serial: string
  name: string
  family: string
  online: boolean
}

/** Alexa (Echo) connection, see main/alexa.ts. */
export interface AlexaStatus {
  state: 'off' | 'login' | 'connecting' | 'ready' | 'error'
  devices: AlexaDevice[]
  error?: string
}

/** Echo → VYRSE skill gateway, see main/alexa-skill.ts (the ngrok token is never sent back). */
export interface EchoSkillStatus {
  state: 'off' | 'starting' | 'running' | 'error'
  enabled: boolean
  domain: string
  skillId: string
  hasToken: boolean
  /** an Amazon user is linked (only that user's requests are answered) */
  linked: boolean
  /** the HTTPS endpoint to paste into the Alexa developer console */
  endpoint: string
  error?: string
}

/** Shape exposed on `window.vyrse` by the preload script. */
export interface VyrseBridge {
  backend: {
    getConnection(): Promise<BackendConnection | null>
    getStatus(): Promise<BackendStatus>
    restart(): Promise<void>
    onStatus(callback: (status: BackendStatus) => void): () => void
  }
  desktop: {
    /** absolute path of a file dropped onto the window */
    pathForFile(file: File): string
    /** main window: report presence so the floating orb can mirror it */
    presence(state: OrbState): void
    /** orb window: presence updates */
    onOrbState(callback: (state: OrbState) => void): () => void
    /** bring the main window to the front */
    showMain(): void
    /** orb window: take mouse input while the pointer is over the pill */
    setInteractive(interactive: boolean): void
    /** register the push-to-talk shortcut (Electron accelerator) or null to remove it; false = taken */
    setTalkShortcut(accelerator: string | null): Promise<boolean>
    /** the push-to-talk shortcut was pressed */
    onTalkShortcut(callback: () => void): () => void
    /** register the dictate-anywhere shortcut, or null to remove it; false = taken */
    setDictateShortcut(accelerator: string | null): Promise<boolean>
    /** the dictate shortcut was pressed */
    onDictateShortcut(callback: () => void): () => void
    /** type text into the focused app; false when VYRSE itself is focused (nothing typed) */
    typeText(text: string): Promise<boolean>
    /** Alexa / Echo: status, connect (Amazon sign-in), disconnect, command, speak, announce */
    alexa(op: string, args?: { text?: string; device?: string }): Promise<unknown>
    onAlexaStatus(callback: (status: AlexaStatus) => void): () => void
    /** Echo → VYRSE skill: status, set, enable, disable, unlink, forget, model */
    echoSkill(op: string, args?: Record<string, unknown>): Promise<unknown>
    onEchoSkillStatus(callback: (status: EchoSkillStatus) => void): () => void
    /** a question from the Echo; answer with echoAnswer(id, text) */
    onEchoAsk(callback: (ask: { id: string; text: string }) => void): () => void
    echoAnswer(id: string, text: string): void
    /** put text on the system clipboard (write only; no permission or click needed) */
    copyText(text: string): Promise<boolean>
    /** main window: register the quick-ask bar shortcut (or null); false = taken */
    setQuickShortcut(accelerator: string | null): Promise<boolean>
    /** main window: a question from the quick-ask bar; stream answers back with quickAnswer */
    onQuickAsk(callback: (ask: { id: string; text: string }) => void): () => void
    quickAnswer(update: QuickUpdate): void
    /** phone bridge: status, enable, disable, pair, cancelPair, remove {id}, allowFirewall */
    phone(op: string, args?: Record<string, unknown>): Promise<unknown>
    onPhoneStatus(callback: (status: PhoneBridgeStatus) => void): () => void
  }
  /** quick-ask bar window */
  quick: {
    ask(id: string, text: string): void
    onUpdate(callback: (update: QuickUpdate) => void): () => void
    onShow(callback: () => void): () => void
    onHide(callback: () => void): () => void
    resize(height: number): void
    hide(): void
    openMain(): void
  }
}

/** Phone bridge (VYRSE on Android over the home Wi-Fi), see main/phone-bridge.ts. */
export interface PhoneBridgeStatus {
  enabled: boolean
  running: boolean
  port: number
  /** this PC's home-network addresses (what the phone connects to) */
  addresses: string[]
  devices: { id: string; name: string; created: number; lastSeen: number; linked?: boolean }[]
  /** an open pairing window: the code to type on the phone */
  pairing: { code: string; expiresIn: number } | null
  error?: string
}

/** Progress of a quick-ask answer. */
export interface QuickUpdate {
  id: string
  text: string
  done: boolean
  error?: boolean
  /** what VYRSE is doing right now (e.g. "Searching files") */
  activity?: string
}
