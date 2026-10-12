import type { AgentSettings, ApprovalPrompt, ClarifyPrompt, ConversationSummary, LinkStatus, StreamEvent } from "@/services/vyrse-api";
import {
  DEFAULT_SETTINGS,
  type Artifact,
  isPresentationMode,
  type Conversation,
  type Message,
  type PresenceState,
  type PresentationMode,
  type Settings,
  type ToolActivity,
} from "./types";

/**
 * The single VYRSE application state.
 *
 * Every change — from the human (clicks, typing, voice), from Hermes' stream, or later
 * from Hermes *controlling the UI* — goes through one typed action and this pure reducer.
 * Side effects (talking to Hermes) live in the provider, never here.
 */
export interface VyrseState {
  settings: Settings;
  link: LinkStatus;
  /** Hermes-owned agent settings (model, reasoning, approvals, memory); null until loaded */
  agent: AgentSettings | null;
  conversations: Conversation[];
  activeId: string | null;
  presence: PresenceState;
  listening: boolean;
  micLive: boolean;
  /** the turn in flight, if any */
  turn: { conversationId: string; replyId: string; startedAt: number } | null;
  error: string | null;
  /** short-lived status line from Hermes ("Queued behind the current task") */
  notice: string | null;
  /** brief on-screen message (Hermes `notify`, mode changes) */
  toast: string | null;
  /** Hermes approval prompts awaiting the user, oldest first */
  approvals: ApprovalPrompt[];
  /** questions Hermes is asking the user mid-task, oldest first */
  clarifications: ClarifyPrompt[];
  /** items Hermes put in the workspace panel (vyrse_workspace), newest first */
  workspace: Artifact[];
  /** ids of workspace items that arrived while the workspace was hidden (the badge count) */
  workspaceUnseen: string[];
  /** the one workspace item shown on its own (the user's zoom, or Hermes' action=focus) */
  workspaceFocus: string | null;
  ui: {
    historyOpen: boolean;
    settingsOpen: boolean;
    expanded: boolean;
    presentation: PresentationMode;
  };
  booted: boolean;
}

export const INITIAL_STATE: VyrseState = {
  settings: DEFAULT_SETTINGS,
  link: { phase: "starting", message: "Starting Hermes" },
  agent: null,
  conversations: [],
  activeId: null,
  presence: "idle",
  listening: false,
  micLive: false,
  turn: null,
  error: null,
  notice: null,
  toast: null,
  approvals: [],
  clarifications: [],
  workspace: [],
  workspaceUnseen: [],
  workspaceFocus: null,
  ui: { historyOpen: false, settingsOpen: false, expanded: false, presentation: "compact" },
  booted: false,
};

export type VyrseAction =
  | { type: "settings/patch"; patch: Partial<Settings> }
  | { type: "link/update"; link: LinkStatus }
  | { type: "agent/loaded"; agent: AgentSettings }
  | { type: "agent/patch"; patch: Partial<AgentSettings> }
  | { type: "conversations/listed"; rows: ConversationSummary[] }
  | { type: "conversation/upsert"; summary: ConversationSummary; messages?: Message[] }
  | { type: "conversation/select"; id: string | null }
  | { type: "conversation/removed"; id: string }
  | { type: "conversation/dropLastTurn"; id: string }
  | { type: "conversation/renamed"; id: string; title: string }
  | { type: "turn/start"; conversationId: string; userMessage: Message; replyId: string; title?: string }
  | { type: "turn/event"; event: StreamEvent }
  | { type: "turn/end"; outcome: "success" | "error" | "interrupted"; error?: string }
  | { type: "presence/set"; presence: PresenceState }
  | { type: "voice/listening"; listening: boolean; micLive: boolean }
  | { type: "error/set"; error: string | null }
  | { type: "notice/set"; notice: string | null }
  | { type: "toast/set"; toast: string | null }
  | { type: "approval/add"; prompt: ApprovalPrompt }
  | { type: "approval/remove"; id: string }
  | { type: "clarify/add"; prompt: ClarifyPrompt }
  | { type: "clarify/remove"; id: string }
  | { type: "ui/history"; open: boolean }
  | { type: "ui/settings"; open: boolean }
  | { type: "ui/expanded"; expanded: boolean }
  | { type: "ui/presentation"; mode: PresentationMode }
  | { type: "workspace/show"; artifact: Artifact }
  | { type: "workspace/remove"; id: string }
  | { type: "workspace/clear" }
  | { type: "workspace/replace"; items: Artifact[] }
  | { type: "workspace/check"; id: string; index: number; done: boolean }
  | { type: "workspace/focus"; id: string | null }
  | { type: "booted" };

export function vyrseReducer(state: VyrseState, action: VyrseAction): VyrseState {
  switch (action.type) {
    case "settings/patch":
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case "link/update":
      return { ...state, link: action.link };

    case "agent/loaded":
      return { ...state, agent: action.agent };

    case "agent/patch":
      return state.agent ? { ...state, agent: { ...state.agent, ...action.patch } } : state;

    case "conversations/listed": {
      // Keep transcripts we already loaded; take titles/ordering from Hermes.
      const known = new Map(state.conversations.map((c) => [c.id, c]));
      const listed = action.rows.map<Conversation>((row) => {
        const prev = known.get(row.id);
        return {
          id: row.id,
          title: row.title,
          updatedAt: Math.max(row.updatedAt, prev?.updatedAt ?? 0),
          preview: row.preview,
          messages: prev?.messages ?? [],
          loaded: prev?.loaded ?? false,
          state: prev?.state,
        };
      });
      const listedIds = new Set(listed.map((c) => c.id));
      // A conversation created this session may not be in Hermes' list until its first prompt.
      const localOnly = state.conversations.filter((c) => !listedIds.has(c.id) && c.messages.length > 0);
      return { ...state, conversations: [...localOnly, ...listed] };
    }

    case "conversation/upsert": {
      const { summary, messages } = action;
      const exists = state.conversations.some((c) => c.id === summary.id);
      const next: Conversation[] = exists
        ? state.conversations.map((c) =>
            c.id === summary.id
              ? {
                  ...c,
                  title: summary.title || c.title,
                  updatedAt: summary.updatedAt,
                  ...(messages ? { messages, loaded: true } : {}),
                }
              : c,
          )
        : [
            {
              id: summary.id,
              title: summary.title,
              updatedAt: summary.updatedAt,
              preview: summary.preview,
              messages: messages ?? [],
              loaded: messages !== undefined || summary.messageCount === 0,
            },
            ...state.conversations,
          ];
      return { ...state, conversations: next };
    }

    case "conversation/select":
      return {
        ...state,
        activeId: action.id,
        error: null,
        // Each conversation has its own board; the store loads the new one's saved items.
        workspace: action.id === state.activeId ? state.workspace : [],
        workspaceUnseen: action.id === state.activeId ? state.workspaceUnseen : [],
        workspaceFocus: action.id === state.activeId ? state.workspaceFocus : null,
        ui: { ...state.ui, historyOpen: false, expanded: false, presentation: "compact" },
      };

    case "conversation/dropLastTurn":
      return {
        ...state,
        conversations: patchConversation(state.conversations, action.id, (c) => {
          const lastUser = c.messages.map((m) => m.role).lastIndexOf("user");
          return lastUser < 0 ? c : { ...c, messages: c.messages.slice(0, lastUser) };
        }),
      };

    case "conversation/renamed":
      return {
        ...state,
        conversations: patchConversation(state.conversations, action.id, (c) => ({ ...c, title: action.title })),
      };

    case "conversation/removed":
      return {
        ...state,
        conversations: state.conversations.filter((c) => c.id !== action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
      };

    case "turn/start": {
      const reply: Message = {
        id: action.replyId,
        role: "vyrse",
        text: "",
        createdAt: Date.now(),
        streaming: true,
      };
      return {
        ...state,
        error: null,
        notice: null,
        presence: "thinking",
        activeId: action.conversationId,
        turn: { conversationId: action.conversationId, replyId: action.replyId, startedAt: Date.now() },
        conversations: patchConversation(state.conversations, action.conversationId, (c) => ({
          ...c,
          title: c.messages.length === 0 && action.title ? action.title : c.title,
          updatedAt: Date.now(),
          state: "ok",
          messages: [...c.messages, action.userMessage, reply],
        })),
      };
    }

    case "turn/event":
      return applyTurnEvent(state, action.event);

    case "turn/end": {
      const turn = state.turn;
      if (!turn) return state;
      const failed = action.outcome === "error";
      return {
        ...state,
        turn: null,
        notice: null,
        presence: failed ? "error" : action.outcome === "interrupted" ? "idle" : "success",
        error: failed ? (action.error ?? "Hermes couldn't complete that.") : state.error,
        conversations: patchConversation(state.conversations, turn.conversationId, (c) => ({
          ...c,
          state: failed ? "error" : c.state,
          messages: c.messages
            .map((m) =>
              m.id === turn.replyId
                ? {
                    ...m,
                    text: withoutRepeat(m.text),
                    streaming: false,
                    interrupted: action.outcome === "interrupted" || undefined,
                    tools: m.tools?.map((t) => (t.status === "done" ? t : { ...t, status: "done" as const })),
                  }
                : m,
            )
            // An empty failed reply with no tool activity is noise (the error banner explains it).
            // A stopped reply stays, so the transcript shows the user stopped it.
            .filter(
              (m) =>
                m.id !== turn.replyId || action.outcome !== "error" || m.text.trim() !== "" || (m.tools?.length ?? 0) > 0,
            ),
        })),
      };
    }

    case "presence/set":
      return { ...state, presence: action.presence };

    case "voice/listening":
      return { ...state, listening: action.listening, micLive: action.micLive };

    case "error/set":
      return { ...state, error: action.error };

    case "notice/set":
      return { ...state, notice: action.notice };

    case "toast/set":
      return { ...state, toast: action.toast };

    case "approval/add":
      if (state.approvals.some((a) => a.id === action.prompt.id)) return state;
      return { ...state, approvals: [...state.approvals, action.prompt] };

    case "approval/remove":
      return { ...state, approvals: state.approvals.filter((a) => a.id !== action.id) };

    case "clarify/add":
      if (state.clarifications.some((c) => c.id === action.prompt.id)) return state;
      return { ...state, clarifications: [...state.clarifications, action.prompt] };

    case "clarify/remove":
      return { ...state, clarifications: state.clarifications.filter((c) => c.id !== action.id) };

    case "ui/history":
      return { ...state, ui: { ...state.ui, historyOpen: action.open } };
    case "ui/settings":
      return { ...state, ui: { ...state.ui, settingsOpen: action.open } };
    case "ui/expanded":
      return seen({ ...state, ui: { ...state.ui, expanded: action.expanded } });
    case "workspace/show": {
      // Same id, or the same data under another title (shown twice in one answer), updates in place and
      // keeps its position; new items go first. At most 24 kept.
      const key = artifactContent(action.artifact);
      const match = state.workspace.find((a) => a.id === action.artifact.id || artifactContent(a) === key);
      const workspace = match
        ? state.workspace.map((a) => (a === match ? { ...action.artifact, at: match.at } : a))
        : [{ ...action.artifact, at: Date.now() }, ...state.workspace].slice(0, 24);
      // Only something new counts as unseen — a live chart updating in place doesn't re-raise the badge.
      const unseen = !match && !workspaceVisible(state) && action.artifact.id
        ? [...state.workspaceUnseen.filter((id) => id !== action.artifact.id), action.artifact.id]
        : state.workspaceUnseen;
      return { ...state, workspace, workspaceUnseen: keepExisting(unseen, workspace) };
    }
    case "workspace/remove": {
      const workspace = state.workspace.filter((a) => a.id !== action.id);
      return {
        ...state,
        workspace,
        workspaceUnseen: keepExisting(state.workspaceUnseen, workspace),
        workspaceFocus: state.workspaceFocus === action.id ? null : state.workspaceFocus,
      };
    }
    case "workspace/clear":
      return { ...state, workspace: [], workspaceUnseen: [], workspaceFocus: null };
    case "workspace/replace":
      // A conversation's saved board: nothing in it is news.
      return { ...state, workspace: action.items.slice(0, 24), workspaceUnseen: [], workspaceFocus: null };
    case "workspace/focus":
      return { ...state, workspaceFocus: action.id && state.workspace.some((a) => a.id === action.id) ? action.id : null };
    case "workspace/check":
      return {
        ...state,
        workspace: state.workspace.map((a) =>
          a.id === action.id && a.checklist
            ? { ...a, checklist: a.checklist.map((c, i) => (i === action.index ? { ...c, done: action.done } : c)) }
            : a,
        ),
      };

    case "ui/presentation": {
      if (!isPresentationMode(action.mode)) return state;
      return seen({ ...state, ui: { ...state.ui, presentation: action.mode } });
    }

    case "booted":
      return { ...state, booted: true };
  }
}

function applyTurnEvent(state: VyrseState, event: StreamEvent): VyrseState {
  const turn = state.turn;
  if (!turn) return state;
  const patchReply = (fn: (m: Message) => Message): VyrseState => ({
    ...state,
    conversations: patchConversation(state.conversations, turn.conversationId, (c) => ({
      ...c,
      updatedAt: Date.now(),
      messages: c.messages.map((m) => (m.id === turn.replyId ? fn(m) : m)),
    })),
  });

  switch (event.type) {
    case "status":
      // "speaking" is reached when reply text actually arrives.
      return event.status === "speaking" ? state : { ...state, presence: event.status };

    case "reasoning": {
      const next = patchReply((m) => ({ ...m, reasoningChars: (m.reasoningChars ?? 0) + event.delta.length }));
      return { ...next, presence: state.presence === "working" ? "working" : "thinking" };
    }

    case "text": {
      const next = patchReply((m) => ({ ...m, text: `${m.text}${event.delta}`.trimStart() }));
      return { ...next, presence: "speaking" };
    }

    case "tool": {
      const next = patchReply((m) => ({ ...m, tools: upsertTool(m.tools ?? [], event) }));
      return { ...next, presence: event.phase === "end" ? "thinking" : "working" };
    }

    case "notice":
      return { ...state, notice: event.text };

    case "artifact":
      return patchReply((m) => ({ ...m, artifact: event.artifact }));

    case "presentation":
      return isPresentationMode(event.mode) ? { ...state, ui: { ...state.ui, presentation: event.mode } } : state;

    case "done":
    case "error":
      // Terminal events are turned into `turn/end` by the provider.
      return state;
  }
}

function upsertTool(tools: ToolActivity[], event: Extract<StreamEvent, { type: "tool" }>): ToolActivity[] {
  if (event.phase === "generating") {
    if (tools.some((t) => t.status === "preparing" && t.name === event.name)) return tools;
    return [...tools, { id: `gen-${event.name}-${tools.length}`, name: event.name, status: "preparing", startedAt: Date.now() }];
  }
  if (event.phase === "start") {
    const id = event.id ?? `tool-${tools.length}`;
    // Promote the matching "preparing" placeholder rather than adding a duplicate.
    const placeholder = tools.findIndex((t) => t.status === "preparing" && t.name === event.name);
    const started: ToolActivity = { id, name: event.name, label: event.label, status: "running", startedAt: Date.now() };
    if (placeholder >= 0) return tools.map((t, i) => (i === placeholder ? started : t));
    if (tools.some((t) => t.id === id)) return tools;
    return [...tools, started];
  }
  // end
  const index = tools.findIndex((t) => (event.id ? t.id === event.id : t.name === event.name && t.status !== "done"));
  const done: Partial<ToolActivity> = { status: "done", durationS: event.durationS, summary: event.summary };
  if (index < 0) return [...tools, { id: event.id ?? `tool-${tools.length}`, name: event.name, startedAt: Date.now(), ...done } as ToolActivity];
  return tools.map((t, i) => (i === index ? { ...t, ...done } : t));
}

function patchConversation(list: Conversation[], id: string, fn: (c: Conversation) => Conversation): Conversation[] {
  return list.map((c) => (c.id === id ? fn(c) : c));
}

/** Best conversation for a spoken/typed reference ("the telescope one"): most query words in its title. */
export function findConversation(conversations: Conversation[], query: string): Conversation | null {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  let best: { c: Conversation; score: number } | null = null;
  for (const c of conversations) {
    const title = `${c.title} ${c.preview ?? ""}`.toLowerCase();
    const score = words.filter((w) => title.includes(w)).length;
    if (score > 0 && (!best || score > best.score || (score === best.score && c.updatedAt > best.c.updatedAt))) best = { c, score };
  }
  return best?.c ?? null;
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 46)}…` : t || "New conversation";
}

/** An artifact's data without its id, title, caption or chart styling, to spot the same content shown twice. */
/** The workspace panel is on screen (it shares its space with the full transcript). */
export function workspaceVisible(state: VyrseState): boolean {
  return state.ui.presentation !== "compact" && !state.ui.expanded;
}

/** Opening the workspace shows everything in it, so the badge clears. */
function seen(state: VyrseState): VyrseState {
  return workspaceVisible(state) && state.workspaceUnseen.length ? { ...state, workspaceUnseen: [] } : state;
}

function keepExisting(ids: string[], workspace: Artifact[]): string[] {
  return ids.filter((id) => workspace.some((a) => a.id === id));
}

function artifactContent(artifact: Artifact): string {
  const { id: _id, title: _title, caption: _caption, chart: _chart, at: _at, ...content } = artifact;
  return JSON.stringify(content);
}

/** What the running turn is doing right now: "working" while one of its tools runs, else "thinking". */
export function turnActivity(state: VyrseState): "working" | "thinking" {
  const turn = state.turn;
  if (!turn) return "thinking";
  const reply = state.conversations.find((c) => c.id === turn.conversationId)?.messages.find((m) => m.id === turn.replyId);
  return reply?.tools?.some((t) => t.status !== "done") ? "working" : "thinking";
}

/** A reply the model wrote twice in a row ("X\nX") shows once. */
export function withoutRepeat(text: string): string {
  const t = text.trim();
  for (const sep of ["\n\n", "\n", ""]) {
    const half = (t.length - sep.length) / 2;
    if (half >= 12 && Number.isInteger(half) && t.slice(0, half) === t.slice(half + sep.length) && t.slice(half, half + sep.length) === sep)
      return t.slice(0, half);
  }
  return text;
}
