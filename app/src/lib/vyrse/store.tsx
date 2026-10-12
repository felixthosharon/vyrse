import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getVyrseApi } from "@/services";
import { getDesktopBridge } from "@/services/hermes/bridge";
import { speakableReply } from "../voice/speech-text";
import { IS_PHONE, desktopCallViaPc, runPhoneAction } from "@/services/phone";
import { copyText } from "@/lib/clipboard";
import { withLocalWake } from "@/lib/voice/local-wake";
import { parseStyleCommand, styleLabel, type TalkStyle } from "./talk-styles";
import type {
  AgentSettings,
  ApprovalChoice,
  ApprovalPrompt,
  ClarifyPrompt,
  FiredReminder,
  LinkStatus,
  ModelChoice,
  ReasoningLevel,
  UiCommand,
} from "@/services/vyrse-api";
import { createLevelSource, type LevelSource } from "./audio";
import { VoiceController, type VoicePhase } from "../voice/voice-controller";
import { configureUiSounds, playUiSound, preloadUiSounds, startAlarm, stopAlarm } from "./ui-sounds";
import { makeMessage, newId } from "./mock-ai";
import { loadSettings, saveSettings } from "./settings/storage";
import { findConversation, INITIAL_STATE, titleFrom, turnActivity, vyrseReducer, type VyrseAction } from "./state";
import { TALK_SHORTCUTS, DICTATE_SHORTCUTS, QUICK_SHORTCUTS, type Artifact, type Conversation, type PresenceState, type PresentationMode, type Settings } from "./types";

interface VyrseContextValue {
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  resolvedTheme: "dark" | "light";

  /** connection to Hermes */
  link: LinkStatus;
  restartBackend: () => void;

  /** Hermes-owned agent settings; null until Hermes is connected */
  agent: AgentSettings | null;
  setModel: (choice: ModelChoice) => void;
  setReasoning: (level: ReasoningLevel) => void;
  setApprovalMode: (mode: AgentSettings["approvalMode"]) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  setSttModel: (model: string) => void;

  conversations: Conversation[];
  activeId: string | null;
  active: Conversation | null;
  selectConversation: (id: string) => void;
  startNew: () => void;
  deleteConversation: (id: string) => void;
  clearHistory: () => void;
  exportActive: () => void;

  presenceState: PresenceState;
  levelRef: React.RefObject<number>;
  /** preferences have been loaded from Hermes */
  prefsLoaded: boolean;
  /** phone app: listen for "VYRSE" while the app is open (this phone only) */
  phoneWake: boolean;
  setPhoneWake: (on: boolean) => void;
  listening: boolean;
  micLive: boolean;
  toggleListening: () => void;

  send: (text: string, options?: SendOptions) => void;
  /** how VYRSE talks; also switchable by saying "switch to fam mode" */
  setTalkStyle: (style: TalkStyle) => void;
  /** short on-screen message */
  notify: (text: string) => void;
  regenerate: () => void;
  /** Resend the last message with new text (replaces the last exchange). */
  editLast: (text: string) => void;
  /** Read a reply aloud in full. */
  readAloud: (text: string) => void;
  renameConversation: (id: string, title: string) => void;
  cancel: () => void;
  busy: boolean;
  /** user-facing failure text for the current turn, if any */
  error: string | null;
  dismissError: () => void;
  /** short status line from Hermes while a turn runs */
  notice: string | null;
  /** record a few seconds and report level / wake score / transcript */
  testMicrophone: () => Promise<import("../voice/voice-controller").MicTestResult | null>;
  /** record a clip from the live mic (16 kHz int16), for Teach it my voice */
  recordVoiceClip: (seconds: number, onLevel?: (level: number) => void) => Promise<Int16Array | null>;
  /** reload the wake word (after a new model was installed) */
  restartWakeWord: () => Promise<void>;
  /** brief on-screen message */
  toast: string | null;
  /** an alarm ringing right now (rings until stopped or snoozed) */
  alarm: { name: string; text: string } | null;
  stopAlarm: () => void;
  /** ring again in 9 minutes */
  snoozeAlarm: () => void;
  /** VYRSE mode, mapped onto Hermes: gaming unloads the local model, private keeps to local models */
  setMode: (mode: Settings["mode"]) => void;

  /** the Hermes approval prompt currently shown (oldest pending) */
  pendingApproval: ApprovalPrompt | null;
  respondToApproval: (choice: ApprovalChoice) => void;

  /** the question Hermes is currently asking (oldest pending) */
  pendingClarify: ClarifyPrompt | null;
  respondToClarify: (answers: Record<string, string> | null) => void;

  historyOpen: boolean;
  setHistoryOpen: (v: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  /** semantic workspace mode — requested by the backend, sized by the frontend */
  presentation: PresentationMode;
  /** what Hermes put in the workspace panel, newest first */
  workspace: Artifact[];
  /** ids that arrived while the workspace was hidden; cleared when it opens */
  workspaceUnseen: string[];
  removeWorkspaceItem: (id: string) => void;
  checkWorkspaceItem: (id: string, index: number, done: boolean) => void;
  /** the item shown on its own, if any */
  workspaceFocus: string | null;
  focusWorkspaceItem: (id: string | null) => void;
  clearWorkspace: () => void;
  setPresentation: (mode: PresentationMode) => void;

  booted: boolean;
  mode: "landing" | "conversation";

  /** Low-level dispatch; UI actions requested by Hermes use the same path (Phase 5). */
  dispatch: (action: VyrseAction) => void;
}

const Ctx = createContext<VyrseContextValue | null>(null);

export function VyrseProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(vyrseReducer, INITIAL_STATE);
  const api = useMemo(() => getVyrseApi(), []);

  const levelRef = useRef(0);
  const sourceRef = useRef<LevelSource | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hydrated = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // --- settings: hydrate after mount, persist on change (UI preferences only) ----------
  useEffect(() => {
    dispatch({ type: "settings/patch", patch: loadSettings() });
    hydrated.current = true;
    const t = window.setTimeout(() => dispatch({ type: "booted" }), 380);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (hydrated.current) saveSettings(state.settings);
  }, [state.settings]);

  // Interface preferences are shared with Hermes through the vyrse plugin store.
  // localStorage above is only a fast-boot cache so the first paint has the right theme.
  const pendingPrefs = useRef<Partial<Settings>>({});
  /** the saved preferences arrived from Hermes (so a missing name really means a first run) */
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const prefsTimer = useRef<number | null>(null);
  const persistPrefs = useCallback(
    (patch: Partial<Settings>) => {
      if (!api.ui) return;
      Object.assign(pendingPrefs.current, patch);
      if (prefsTimer.current !== null) window.clearTimeout(prefsTimer.current);
      prefsTimer.current = window.setTimeout(() => {
        const toSave = pendingPrefs.current;
        pendingPrefs.current = {};
        prefsTimer.current = null;
        void api.ui?.savePrefs(toSave).catch((err) => console.warn("[vyrse] saving preferences failed:", err));
      }, 400);
    },
    [api],
  );

  useEffect(() => {
    if (state.link.phase !== "online" || !api.ui) return;
    void api.ui
      .loadPrefs()
      .then((prefs) => {
        if (Object.keys(prefs).length) dispatch({ type: "settings/patch", patch: prefs });
        setPrefsLoaded(true);
      })
      .catch((err) => console.warn("[vyrse] loading preferences failed:", err));
  }, [state.link.phase, api]);

  useEffect(() => {
    if (!state.toast) return;
    const t = window.setTimeout(() => dispatch({ type: "toast/set", toast: null }), 4500);
    return () => window.clearTimeout(t);
  }, [state.toast]);

  // --- link to Hermes ----------------------------------------------------------------
  useEffect(() => {
    if (!api.link) {
      dispatch({ type: "link/update", link: { phase: "online", message: "Offline demo mode" } });
      return;
    }
    return api.link.subscribe((link) => dispatch({ type: "link/update", link }));
  }, [api]);

  // --- Hermes-owned agent settings ---------------------------------------------------
  const loadAgent = useCallback(async () => {
    if (!api.agent) return;
    try {
      const next = await api.agent.load();
      // While Hermes restarts its model server (after a model was added/removed) it briefly lists no
      // local models; keep showing the previous list instead of an empty menu.
      const previous = stateRef.current.agent;
      if (previous && !next.models.some((m) => m.local) && previous.models.some((m) => m.local)) {
        next.models = [...previous.models.filter((m) => m.local), ...next.models];
      }
      dispatch({ type: "agent/loaded", agent: next });
    } catch (err) {
      console.warn("[vyrse] agent settings load failed:", err);
    }
  }, [api]);

  useEffect(() => {
    if (state.link.phase === "online") void loadAgent();
  }, [state.link.phase, loadAgent]);

  // Re-read Hermes' settings whenever Settings opens (new local models, changes made elsewhere).
  // Fetched after the panel has slid in, so the update can't land mid-animation.
  useEffect(() => {
    if (!state.ui.settingsOpen || state.link.phase !== "online") return;
    const t = window.setTimeout(() => void loadAgent(), 560);
    return () => window.clearTimeout(t);
  }, [state.ui.settingsOpen, state.link.phase, loadAgent]);

  useEffect(() => {
    if (!api.agent) return;
    return api.agent.onModelChanged((m) => dispatch({ type: "agent/patch", patch: m }));
  }, [api]);

  /** Optimistic update of a Hermes setting; reverts and explains if Hermes refuses. */
  const changeAgent = useCallback(
    (patch: Partial<AgentSettings>, apply: () => Promise<void> | undefined, failure: string) => {
      const before = stateRef.current.agent;
      if (!before) return;
      dispatch({ type: "agent/patch", patch });
      void Promise.resolve(apply()).catch((err) => {
        console.warn("[vyrse] setting change failed:", err);
        dispatch({ type: "agent/loaded", agent: before });
        dispatch({ type: "error/set", error: failure });
      });
    },
    [],
  );

  const setModel = useCallback(
    (choice: ModelChoice) => {
      if (stateRef.current.settings.mode === "private" && !choice.local) {
        dispatch({ type: "error/set", error: "Private mode keeps VYRSE on models that run on this PC." });
        return;
      }
      changeAgent(
        { model: choice.model, provider: choice.provider },
        () => api.agent?.setModel(choice, stateRef.current.activeId),
        `Hermes couldn't switch to ${choice.model}.`,
      );
    },
    [api, changeAgent],
  );
  const setReasoning = useCallback(
    (level: ReasoningLevel) =>
      changeAgent({ reasoning: level }, () => api.agent?.setReasoning(level), "Hermes couldn't change the reasoning level."),
    [api, changeAgent],
  );
  const setApprovalMode = useCallback(
    (mode: AgentSettings["approvalMode"]) =>
      changeAgent({ approvalMode: mode }, () => api.agent?.setApprovalMode(mode), "Hermes couldn't change the approval mode."),
    [api, changeAgent],
  );
  const setMemoryEnabled = useCallback(
    (enabled: boolean) =>
      changeAgent({ memoryEnabled: enabled }, () => api.agent?.setMemoryEnabled(enabled), "Hermes couldn't change memory."),
    [api, changeAgent],
  );

  const setSttModel = useCallback(
    (model: string) =>
      changeAgent({ sttModel: model }, () => api.agent?.setSttModel(model), "Hermes couldn't change speech recognition."),
    [api, changeAgent],
  );

  // --- conversation history (Hermes sessions) ----------------------------------------
  const refreshList = useCallback(async () => {
    if (!api.conversations) return [];
    try {
      const rows = await api.conversations.list();
      dispatch({ type: "conversations/listed", rows });
      return rows;
    } catch (err) {
      console.warn("[vyrse] session list failed:", err);
      return [];
    }
  }, [api]);

  const openConversation = useCallback(
    async (id: string) => {
      if (!api.conversations) return;
      try {
        const { summary, messages } = await api.conversations.open(id);
        dispatch({ type: "conversation/upsert", summary, messages });
      } catch (err) {
        console.warn("[vyrse] failed to open conversation:", err);
        dispatch({ type: "error/set", error: "Couldn't load that conversation from Hermes." });
      }
    },
    [api],
  );

  // On (re)connect: refresh history; on first connect continue the most recent conversation.
  const resumedOnce = useRef(false);
  useEffect(() => {
    if (state.link.phase !== "online" || !api.conversations) return;
    void (async () => {
      const rows = await refreshList();
      if (resumedOnce.current) return;
      resumedOnce.current = true;
      // Continue the latest conversation that has something in it (never an empty placeholder).
      const sorted = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
      const latest = sorted.find((r) => (r.messageCount ?? 1) > 0) ?? sorted[0];
      if (latest && !stateRef.current.activeId) {
        dispatch({ type: "conversation/select", id: latest.id });
        await openConversation(latest.id);
      }
    })();
  }, [state.link.phase, api, refreshList, openConversation]);

  useEffect(() => {
    if (!api.conversations) return;
    let timer: number | null = null;
    const off = api.conversations.onChanged(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshList(), 400);
    });
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [api, refreshList]);

  // --- approvals (Hermes decides what needs one; we render and answer) ---------------
  useEffect(() => {
    if (!api.approvals) return;
    const offRequest = api.approvals.onRequest((prompt) => dispatch({ type: "approval/add", prompt }));
    const offCancel = api.approvals.onCancel((id) => dispatch({ type: "approval/remove", id }));
    return () => {
      offRequest();
      offCancel();
    };
  }, [api]);

  const respondToApproval = useCallback(
    (choice: ApprovalChoice) => {
      const prompt = stateRef.current.approvals[0];
      if (!prompt) return;
      dispatch({ type: "approval/remove", id: prompt.id });
      if (choice === "deny") playUiSound("deny");
      api.approvals?.respond(prompt.id, choice);
    },
    [api],
  );

  useEffect(() => {
    if (!api.clarify) return;
    const offRequest = api.clarify.onRequest((prompt) => dispatch({ type: "clarify/add", prompt }));
    const offCancel = api.clarify.onCancel((id) => dispatch({ type: "clarify/remove", id }));
    return () => {
      offRequest();
      offCancel();
    };
  }, [api]);

  const respondToClarify = useCallback(
    (answers: Record<string, string> | null) => {
      const prompt = stateRef.current.clarifications[0];
      if (!prompt) return;
      dispatch({ type: "clarify/remove", id: prompt.id });
      if (prompt.id.startsWith(CONFIRM_PREFIX)) {
        const said = answers?.["choice"];
        if (!said || /^(?:cancel|not now|no|deny)/i.test(said)) playUiSound("deny");
        void api.ui?.answerConfirm(prompt.id.slice(CONFIRM_PREFIX.length), answers?.["choice"] ?? null).catch((err) =>
          console.warn("[vyrse] confirm answer failed:", err),
        );
        return;
      }
      api.clarify?.respond(prompt.id, answers);
    },
    [api],
  );

  // VYRSE asking first (Hermes' permission dialog, a plugin's yes/no, a clarify question): one soft cue.
  const askingCount = state.approvals.length + state.clarifications.length;
  const askingBefore = useRef(0);
  useEffect(() => {
    if (askingCount > askingBefore.current) playUiSound("ask");
    askingBefore.current = askingCount;
  }, [askingCount]);

  // --- interface sounds follow Settings (switch, volume, output device) -------------------
  useEffect(() => {
    configureUiSounds({ enabled: state.settings.uiSounds, volume: state.settings.volume, outputDevice: IS_PHONE ? "default" : state.settings.outputDevice });
  }, [state.settings.uiSounds, state.settings.volume, state.settings.outputDevice]);
  useEffect(() => {
    if (state.booted && state.settings.uiSounds) preloadUiSounds();
  }, [state.booted, state.settings.uiSounds]);

  // --- presence settles back to idle after success/error -----------------------------
  // (not while the voice is still reading the reply out: the voice says when it's done)
  const voicePhaseRef = useRef<VoicePhase>("off");
  useEffect(() => {
    if (state.presence !== "success" && state.presence !== "error") return;
    if (voicePhaseRef.current === "speaking") return;
    const t = window.setTimeout(() => dispatch({ type: "presence/set", presence: "idle" }), state.presence === "error" ? 1600 : 1000);
    return () => window.clearTimeout(t);
  }, [state.presence]);

  // --- resolved theme (system aware) -------------------------------------------------
  const prefersLight = useMediaQuery("(prefers-color-scheme: light)");
  const resolvedTheme: "dark" | "light" =
    state.settings.theme === "light" || (state.settings.theme === "system" && prefersLight) ? "light" : "dark";

  // --- voice (Hermes wake word / STT / TTS; VYRSE owns mic + speaker) ------------------
  const voiceRef = useRef<VoiceController | null>(null);
  const startNewRef = useRef<() => void>(() => {});
  /** Dictate anywhere: "listening" while capturing, "typing" while the words are pasted. */
  const [dictation, setDictation] = useState<"off" | "listening" | "typing">("off");
  const sendRef = useRef<(text: string, options?: SendOptions) => void>(() => {});
  const cancelRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!api.voice) return;
    const controller = new VoiceController(IS_PHONE ? withLocalWake(api.voice) : api.voice, {
      onPhase: (phase: VoicePhase) => {
        if (IS_PHONE) console.info(`[vyrse:voice] ${phase}`);
        const wasSpeaking = voicePhaseRef.current === "speaking";
        voicePhaseRef.current = phase;
        const capturing = phase === "capturing" || phase === "followup";
        dispatch({ type: "voice/listening", listening: capturing, micLive: phase !== "off" });
        if (capturing) dispatch({ type: "presence/set", presence: "listening" });
        else if (phase === "transcribing") dispatch({ type: "presence/set", presence: "thinking" });
        else if (phase === "speaking") dispatch({ type: "presence/set", presence: "speaking" });
        else if (stateRef.current.turn) {
          // Finished saying a line while the turn goes on (e.g. "let me check" before a tool): back to
          // what the agent is actually doing, not a stale "responding".
          if (wasSpeaking) dispatch({ type: "presence/set", presence: turnActivity(stateRef.current) });
        } else if (phase === "wake" || phase === "idle" || wasSpeaking) dispatch({ type: "presence/set", presence: "idle" });
      },
      onTranscript: (text) => {
        if (!stateRef.current.turn) {
          sendRef.current(text, { voice: true });
          return;
        }
        // Said the wake word mid-task. "Stop" just stops; a one-word fragment is ignored (likely noise);
        // anything else replaces the current request.
        const words = text.toLowerCase().replace(/[^a-z' ]/g, " ").trim().split(/\s+/).filter(Boolean);
        if (/^(stop|cancel|never ?mind|nevermind|wait|hold on)$/.test(words.join(" "))) {
          cancelRef.current();
          return;
        }
        if (words.length < 2) return;
        cancelRef.current();
        const started = Date.now();
        const waitForIdle = () => {
          if (!stateRef.current.turn) sendRef.current(text, { voice: true });
          else if (Date.now() - started < 8000) window.setTimeout(waitForIdle, 150);
          else dispatch({ type: "toast/set", toast: "VYRSE is still stopping the last task; say that again in a moment." });
        };
        waitForIdle();
      },
      onDictation: (text) => {
        void (async () => {
          setDictation("typing");
          const typed = await getDesktopBridge()?.desktop?.typeText?.(text).catch(() => false);
          // VYRSE itself is in front (or no desktop shell): the words go into the message box instead.
          if (!typed) window.dispatchEvent(new CustomEvent("vyrse:insert-text", { detail: text }));
          setDictation("off");
        })();
      },
      onDictating: (active) => setDictation(active ? "listening" : "off"),
      onError: (message) => {
        console.warn(`[vyrse:voice] error shown: ${message}`);
        dispatch({ type: "toast/set", toast: message });
      },
    });
    voiceRef.current = controller;
    return () => {
      voiceRef.current = null;
      void controller.disable();
    };
  }, [api]);

  const s = state.settings;
  // The phone's own wake-word switch (this phone only): on-device detection while VYRSE is on screen.
  const [phoneWake, setPhoneWakeState] = useState(() => {
    try {
      return localStorage.getItem("vyrse.phone.wake") !== "off";
    } catch {
      return true;
    }
  });
  const setPhoneWake = useCallback((on: boolean) => {
    setPhoneWakeState(on);
    try {
      localStorage.setItem("vyrse.phone.wake", on ? "on" : "off");
    } catch {}
  }, []);
  useEffect(() => {
    voiceRef.current?.configure({
      wakeWord: IS_PHONE ? phoneWake : s.voiceActivation,
      chatty: s.talkStyle === "vibe" || s.talkStyle === "fam" || s.talkStyle === "savage",
      // Without the wake word the phone only opens the mic for a tap (Android shows it as in use).
      releaseMicWhenIdle: IS_PHONE && !phoneWake,
      // Device choices are the PC's (settings are shared with it); the phone uses its own defaults.
      deviceId: IS_PHONE ? "auto" : s.micDevice,
      outputDeviceId: IS_PHONE ? "default" : s.outputDevice,
      sensitivity: s.micSensitivity,
      volume: s.volume,
      followUpMs: s.autoListen ? 6000 : 0,
      autoGain: s.autoGain,
    });
  }, [s.voiceActivation, s.micDevice, s.outputDevice, s.micSensitivity, s.volume, s.autoListen, s.autoGain, phoneWake, s.talkStyle]);

  // Esc stops VYRSE talking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") voiceRef.current?.stopSpeakingNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+N new chat, Ctrl+K search history, Ctrl+, settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        startNewRef.current();
        dispatch({ type: "ui/settings", open: false });
        dispatch({ type: "ui/history", open: false });
        window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")?.focus(), 0);
      } else if (key === "k") {
        e.preventDefault();
        dispatch({ type: "ui/settings", open: false });
        dispatch({ type: "ui/history", open: !stateRef.current.ui.historyOpen });
      } else if (key === ",") {
        e.preventDefault();
        dispatch({ type: "ui/history", open: false });
        dispatch({ type: "ui/settings", open: !stateRef.current.ui.settingsOpen });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Warm the model's prompt cache once per connection so the first request (often spoken) is quick.
  // Skipped in gaming mode, where the GPU belongs to the game.
  const warmedFor = useRef<string | null>(null);
  useEffect(() => {
    if (state.link.phase !== "online" || s.mode === "gaming" || !api.warmUp) return;
    const key = state.link.hermesVersion ?? "online";
    if (warmedFor.current === key) return;
    warmedFor.current = key;
    const started = performance.now();
    void api
      .warmUp()
      .then(() => console.info(`[vyrse] model warmed in ${Math.round(performance.now() - started)} ms`))
      .catch((err) => console.warn("[vyrse] warm-up skipped:", err));
  }, [state.link.phase, state.link.hermesVersion, s.mode, api]);

  // Always listening for "wairz" while connected and enabled; never in gaming mode.
  useEffect(() => {
    const voice = voiceRef.current;
    if (!voice) return;
    if (IS_PHONE) {
      // Listening for "VYRSE" only while the app is on screen; in the background the mic is released.
      const sync = () => {
        if (phoneWake && state.link.phase === "online" && document.visibilityState === "visible") void voice.enable();
        else if (!phoneWake || document.visibilityState !== "visible") void voice.disable();
      };
      sync();
      document.addEventListener("visibilitychange", sync);
      return () => document.removeEventListener("visibilitychange", sync);
    }
    if (state.link.phase === "online" && s.voiceActivation && s.mode !== "gaming") void voice.enable();
    else if (!s.voiceActivation || s.mode === "gaming") void voice.disable();
    return undefined;
  }, [state.link.phase, s.voiceActivation, s.mode, phoneWake]);

  // Workspace board of the open conversation, saved by the vyrse plugin (survives restarts).
  useEffect(() => {
    const conversationId = state.activeId;
    if (state.link.phase !== "online" || !conversationId || !api.ui) return;
    let cancelled = false;
    api.ui
      .loadWorkspace(conversationId)
      .then((items) => {
        if (!cancelled && stateRef.current.activeId === conversationId) dispatch({ type: "workspace/replace", items });
      })
      .catch((err) => console.warn("[vyrse] workspace load failed:", err));
    return () => {
      cancelled = true;
    };
  }, [state.activeId, state.link.phase, api]);

  // Reminders and routines: show and speak each result as Hermes' scheduler fires it.
  const [reminderLabel, setReminderLabel] = useState<string | null>(null);
  const [alarm, setAlarm] = useState<{ name: string; text: string } | null>(null);
  const snoozeTimer = useRef<number | null>(null);
  const ringAlarm = useCallback((next: { name: string; text: string }) => {
    if (snoozeTimer.current !== null) window.clearTimeout(snoozeTimer.current);
    snoozeTimer.current = null;
    setAlarm(next);
    startAlarm();
    // Bring the window up so it can be stopped (the desktop shell shows it over other apps).
    getDesktopBridge()?.desktop?.showMain();
  }, []);
  const stopRinging = useCallback(() => {
    stopAlarm();
    setAlarm((current) => {
      if (current) {
        // Once it's quiet, the wake-up line.
        const voice = voiceRef.current;
        if (voice && stateRef.current.settings.voiceResponses) {
          const speaker = voice.speakReply({ followUp: false });
          speaker.push(`${current.text}
`);
          speaker.end();
        }
      }
      return null;
    });
  }, []);
  const snoozeAlarm = useCallback(() => {
    stopAlarm();
    setAlarm((current) => {
      if (current) snoozeTimer.current = window.setTimeout(() => ringAlarm(current), 9 * 60 * 1000);
      return null;
    });
    dispatch({ type: "toast/set", toast: "Snoozed: ringing again in 9 minutes." });
  }, [ringAlarm]);
  useEffect(() => {
    const reminders = api.reminders;
    if (state.link.phase !== "online" || !reminders) return;
    let since: number | null = null;
    const seen = new Set<string>();
    let labelTimer: number | null = null;
    const announce = (r: FiredReminder) => {
      const key = `${r.jobId}@${r.at}`;
      if (seen.has(key)) return;
      seen.add(key);
      const text = r.ok ? r.text : `"${r.name}" couldn't run. Open Settings, Reminders for details.`;
      // An alarm rings until it's stopped; its wake-up line is said after.
      if (/^Alarm/.test(r.name)) {
        ringAlarm({ name: r.name, text });
        return;
      }
      playUiSound("reminder");
      dispatch({ type: "toast/set", toast: `⏰ ${r.name}: ${text.length > 180 ? `${text.slice(0, 177)}…` : text}` });
      setReminderLabel(r.name.length > 28 ? `${r.name.slice(0, 27)}…` : r.name);
      if (labelTimer !== null) window.clearTimeout(labelTimer);
      labelTimer = window.setTimeout(() => setReminderLabel(null), 10000);
      const voice = voiceRef.current;
      if (voice && stateRef.current.settings.voiceResponses && !stateRef.current.turn) {
        const speaker = voice.speakReply({ followUp: false });
        speaker.push(`${text}\n`);
        speaker.end();
      }
    };
    const poll = async () => {
      try {
        // First call only learns the server clock: results from before VYRSE opened aren't replayed.
        const res = await reminders.fired(since ?? Number.MAX_SAFE_INTEGER);
        if (since !== null) res.fired.forEach(announce);
        since = res.now;
      } catch (err) {
        console.warn("[vyrse] reminder check failed:", err);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 15000);
    return () => {
      window.clearInterval(timer);
      if (labelTimer !== null) window.clearTimeout(labelTimer);
    };
  }, [state.link.phase, api]);

  // Status pill (desktop): mirrors presence with a short caption while the window is minimised or behind others.
  const turnActive = state.turn !== null;
  const runningTool = useMemo(() => {
    const turn = state.turn;
    if (!turn) return null;
    const reply = state.conversations.find((c) => c.id === turn.conversationId)?.messages.find((m) => m.id === turn.replyId);
    const tools = reply?.tools ?? [];
    // Tools finish in about a second while the model thinks between them, so caption the latest one.
    return tools[tools.length - 1]?.name ?? null;
  }, [state]);
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!desktop) return;
    if (reminderLabel) {
      desktop.presence({ active: true, presence: "reminder", label: reminderLabel });
      return;
    }
    if (dictation !== "off") {
      desktop.presence({
        active: true,
        presence: dictation === "listening" ? "listening" : "working",
        label: dictation === "listening" ? "Dictating… pause when you're done" : "Typing it in…",
      });
      return;
    }
    const busy = ["listening", "thinking", "working", "speaking"].includes(state.presence);
    const presence = busy ? state.presence : "thinking";
    const label =
      presence === "speaking" || presence === "listening" ? undefined : runningTool ? pillCaption(runningTool) : undefined;
    desktop.presence({ active: busy || turnActive, presence: label ? "working" : presence, ...(label ? { label } : {}) });
  }, [state.presence, turnActive, reminderLabel, runningTool, dictation]);

  // Presence level: voice controller (Hermes mode) or the browser analyser (demo mode).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const voice = voiceRef.current;
      const src = sourceRef.current;
      levelRef.current = voice ? voice.level() : src ? src.getLevel() * (0.4 + s.micSensitivity) : 0;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [s.micSensitivity]);

  useEffect(
    () => () => {
      sourceRef.current?.stop();
      abortRef.current?.abort();
    },
    [],
  );

  const stopMic = useCallback(() => {
    sourceRef.current?.stop();
    sourceRef.current = null;
    if (!voiceRef.current) dispatch({ type: "voice/listening", listening: false, micLive: false });
  }, []);

  /** The mic button: tap to talk (or stop listening). */
  const toggleListening = useCallback(() => {
    const voice = voiceRef.current;
    if (voice) {
      if (voice.current === "speaking") voice.stopSpeakingNow();
      else if (voice.current === "capturing" || voice.current === "followup") voice.cancelCapture();
      else void voice.listenNow();
      return;
    }
    if (stateRef.current.listening) {
      stopMic();
      dispatch({ type: "voice/listening", listening: false, micLive: false });
      if (stateRef.current.presence === "listening") dispatch({ type: "presence/set", presence: "idle" });
      return;
    }
    const src = createLevelSource();
    sourceRef.current = src;
    dispatch({ type: "voice/listening", listening: true, micLive: false });
    dispatch({ type: "presence/set", presence: "listening" });
    void src.start().then(({ live }) => dispatch({ type: "voice/listening", listening: true, micLive: live }));
  }, [stopMic]);

  // Push-to-talk (desktop): a system-wide shortcut. Pressed while VYRSE talks, it stops and listens;
  // while listening, it cancels; otherwise it starts listening.
  const talkShortcut = state.settings.talkShortcut;
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!desktop?.setTalkShortcut) return;
    const choice = TALK_SHORTCUTS[talkShortcut] ?? TALK_SHORTCUTS["ctrl+shift+space"];
    void desktop.setTalkShortcut(choice.accelerator).then((ok) => {
      if (!ok) dispatch({ type: "toast/set", toast: `${choice.label} is already used by another app. Pick another talk shortcut in Settings → Voice.` });
    });
  }, [talkShortcut]);
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!desktop?.onTalkShortcut) return;
    return desktop.onTalkShortcut(() => {
      const voice = voiceRef.current;
      if (voice && voice.current !== "capturing" && voice.current !== "followup") void voice.listenNow();
      else toggleListening();
    });
  }, [toggleListening]);

  // Automatic daily briefing, at most once a day: on the first start after 4 AM, or at the chosen time.
  const briefingSetting = state.settings.briefing;
  const linkOnline = state.link.phase === "online";
  useEffect(() => {
    if (!linkOnline || !briefingSetting || briefingSetting === "off") return;
    const KEY = "vyrse.lastBriefing";
    const check = () => {
      const now = new Date();
      const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
      let last: string | null = null;
      try {
        last = window.localStorage.getItem(KEY);
      } catch {}
      if (last === today) return;
      const minutes = now.getHours() * 60 + now.getMinutes();
      if (briefingSetting === "start") {
        if (now.getHours() < 4) return;
      } else {
        const [h, m] = briefingSetting.split(":").map(Number);
        const at = (h ?? 0) * 60 + (m ?? 0);
        // Due from the set time until noon (VYRSE opened late in the morning still gets it).
        if (minutes < at || now.getHours() >= 12) return;
      }
      const st = stateRef.current;
      if (st.turn || st.settings.mode === "gaming") return;
      try {
        window.localStorage.setItem(KEY, today);
      } catch {}
      startNewRef.current();
      window.setTimeout(() => sendRef.current("Give me my daily briefing.", { voice: true }), 300);
    };
    const first = window.setTimeout(check, 4000);
    const timer = window.setInterval(check, 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [briefingSetting, linkOnline]);

  // Echo → VYRSE ("Alexa, ask Vyse …"): the question runs like a typed message; the answer goes back
  // to the Echo as a short spoken reply (the full reply stays on screen).
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!desktop?.onEchoAsk || !desktop.echoAnswer) return;
    const answer = desktop.echoAnswer;
    return desktop.onEchoAsk(({ id, text }) => {
      if (stateRef.current.turn) {
        answer(id, "I'm in the middle of something on the PC. Try again in a sec.");
        return;
      }
      sendRef.current(text);
      void (async () => {
        const started = Date.now();
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
        let turnId: string | null = null;
        while (Date.now() - started < 4000 && !turnId) {
          turnId = stateRef.current.turn?.replyId ?? null;
          await wait(80);
        }
        if (!turnId) return answer(id, "Sorry, VYRSE couldn't start on that.");
        let conversationId = stateRef.current.turn?.conversationId ?? stateRef.current.activeId;
        while (Date.now() - started < 175_000 && stateRef.current.turn?.replyId === turnId) {
          conversationId = stateRef.current.turn?.conversationId ?? conversationId;
          await wait(120);
        }
        const reply = stateRef.current.conversations.find((c) => c.id === conversationId)?.messages.find((m) => m.id === turnId);
        const text = reply?.text ? speakableReply(reply.text) : "";
        answer(id, text || "Done. It's on your screen.");
      })();
    });
  }, []);

  // Quick-ask bar (desktop): Alt+Space over any app; the answer streams back into the bar.
  const quickShortcut = state.settings.quickShortcut;
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!desktop?.setQuickShortcut) return;
    const choice = QUICK_SHORTCUTS[quickShortcut] ?? QUICK_SHORTCUTS["alt+space"];
    void desktop.setQuickShortcut(choice.accelerator).then((ok) => {
      if (!ok) dispatch({ type: "toast/set", toast: `${choice.label} is already used by another app. Pick another quick-ask shortcut in Settings → Voice.` });
    });
  }, [quickShortcut]);
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!desktop?.onQuickAsk || !desktop.quickAnswer) return;
    const reply = desktop.quickAnswer;
    return desktop.onQuickAsk(({ id, text }) => {
      if (stateRef.current.turn) {
        reply({ id, text: "VYRSE is busy with something right now. Try again in a moment.", done: true, error: true });
        return;
      }
      sendRef.current(text);
      void (async () => {
        const started = Date.now();
        const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
        let turnId: string | null = null;
        while (Date.now() - started < 4000 && !turnId) {
          turnId = stateRef.current.turn?.replyId ?? null;
          await wait(60);
        }
        if (!turnId) return reply({ id, text: "Couldn't start on that.", done: true, error: true });
        let conversationId = stateRef.current.turn?.conversationId ?? stateRef.current.activeId;
        const current = () =>
          stateRef.current.conversations.find((c) => c.id === conversationId)?.messages.find((m) => m.id === turnId);
        let sent = "";
        let sentActivity = "";
        while (Date.now() - started < 300_000 && stateRef.current.turn?.replyId === turnId) {
          conversationId = stateRef.current.turn?.conversationId ?? conversationId;
          const msg = current();
          const tool = msg?.tools?.at(-1);
          const activity = tool && tool.status === "running" ? pillCaption(tool.name) : "";
          if ((msg?.text ?? "") !== sent || activity !== sentActivity) {
            sent = msg?.text ?? "";
            sentActivity = activity;
            reply({ id, text: sent, done: false, activity });
          }
          await wait(90);
        }
        const msg = current();
        reply({ id, text: msg?.text || "Done.", done: true, error: msg?.interrupted === true && !msg.text });
      })();
    });
  }, []);

  // Dictate anywhere (desktop): its own system-wide shortcut. Pressed again while dictating, it finishes.
  const dictateShortcut = state.settings.dictateShortcut;
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!desktop?.setDictateShortcut) return;
    const choice = DICTATE_SHORTCUTS[dictateShortcut] ?? DICTATE_SHORTCUTS["ctrl+alt+d"];
    void desktop.setDictateShortcut(choice.accelerator).then((ok) => {
      if (!ok) dispatch({ type: "toast/set", toast: `${choice.label} is already used by another app. Pick another dictation shortcut in Settings → Voice.` });
    });
  }, [dictateShortcut]);
  useEffect(() => {
    const desktop = getDesktopBridge()?.desktop;
    if (!desktop?.onDictateShortcut) return;
    return desktop.onDictateShortcut(() => {
      const voice = voiceRef.current;
      if (!voice) {
        dispatch({ type: "toast/set", toast: "Dictation needs VYRSE's voice, which isn't connected yet." });
        return;
      }
      if (stateRef.current.turn && !voice.isDictating) {
        dispatch({ type: "toast/set", toast: "VYRSE is busy with a request; dictate again in a moment." });
        return;
      }
      void voice.dictate();
    });
  }, []);

  // --- turns -------------------------------------------------------------------------
  const send = useCallback(
    (raw: string, options: SendOptions = {}) => {
      const attachments = options.attachments ?? [];
      const text = raw.trim() || (attachments.length ? "Take a look at this." : "");
      const current = stateRef.current;
      if (!text || current.turn) return;
      if (current.listening) stopMic();

      void (async () => {
        let conversationId = current.activeId;
        if (!conversationId) {
          if (api.conversations) {
            try {
              const summary = await api.conversations.create();
              dispatch({ type: "conversation/upsert", summary, messages: [] });
              conversationId = summary.id;
            } catch (err) {
              dispatch({ type: "error/set", error: "Couldn't start a conversation in Hermes." });
              console.warn("[vyrse] session.create failed:", err);
              return;
            }
          } else {
            conversationId = newId();
            dispatch({ type: "conversation/upsert", summary: { id: conversationId, title: "New conversation", updatedAt: Date.now() }, messages: [] });
          }
          dispatch({ type: "conversation/select", id: conversationId });
        }

        const replyId = newId();
        dispatch({
          type: "turn/start",
          conversationId,
          userMessage: makeMessage(
            "user",
            attachments.length ? `${text}\n\n${attachments.map((a) => `📎 ${a.name}`).join("\n")}` : text,
          ),
          replyId,
          title: titleFrom(text),
        });

        const controller = new AbortController();
        abortRef.current = controller;
        // Spoken replies: voice requests always (if voice replies are on); typed ones when "speak typed
        // replies" is on. Only spoken requests open the follow-up listening window afterwards.
        const prefs = stateRef.current.settings;
        const voice = voiceRef.current;
        const speak = Boolean(voice) && prefs.voiceResponses && (options.voice || prefs.speakTyped);
        const speaker = speak ? voice!.speakReply({ followUp: Boolean(options.voice) }) : null;
        const finishVoice = (spokenEnd: boolean) => {
          if (speaker) {
            if (spokenEnd) speaker.end();
            else speaker.cancel();
          }
          if (options.voice && voice && !(speaker && spokenEnd)) voice.replyFinished();
        };
        // Checkpoints: if a request runs a while with nothing said yet, say briefly what's happening.
        let progressTimer: number | null = null;
        let updates = 0;
        let lastTool: string | null = null;
        const scheduleProgress = (delayMs: number) => {
          if (!speaker || updates >= 3) return;
          progressTimer = window.setTimeout(() => {
            if (speaker.started || !stateRef.current.turn) return;
            updates += 1;
            const line = progressLine(lastTool, updates);
            speaker.say(line);
            dispatch({ type: "notice/set", notice: line });
            scheduleProgress(15000);
          }, delayMs);
        };
        scheduleProgress(7000);
        try {
          // Talking should feel immediate; typing can afford Hermes' full reasoning.
          const reasoning = options.voice ? stateRef.current.settings.voiceReasoning : stateRef.current.agent?.reasoning;
          for await (const event of api.stream({ prompt: text, conversationId, voice: options.voice, reasoning, attachments: attachments.map((a) => a.path) }, controller.signal)) {
            if (event.type === "done") {
              dispatch({ type: "turn/end", outcome: event.interrupted ? "interrupted" : "success" });
              finishVoice(!event.interrupted);
              return;
            }
            if (event.type === "error") {
              if (event.detail) console.warn("[vyrse] turn failed:", event.detail);
              dispatch({ type: "turn/end", outcome: "error", error: event.message });
              finishVoice(false);
              return;
            }
            if (event.type === "text") speaker?.push(event.delta);
            if (event.type === "tool" && event.phase !== "end") lastTool = event.name;
            // A new skill saved or installed: the reels' "learned" shimmer.
            if (event.type === "tool" && event.phase === "end" && !/error|fail|not (?:installed|saved)|cancel/i.test(event.summary ?? "") &&
                (event.name === "skill_manage" || (event.name === "vyrse_skills" && /install/i.test(event.summary ?? ""))))
              playUiSound("learned");
            dispatch({ type: "turn/event", event });
          }
          finishVoice(false);
          // Adapters must end with done/error; treat a silent end as interrupted if we aborted.
          dispatch(
            controller.signal.aborted
              ? { type: "turn/end", outcome: "interrupted" }
              : { type: "turn/end", outcome: "error", error: "The response ended unexpectedly." },
          );
        } catch (err) {
          finishVoice(false);
          console.warn("[vyrse] turn crashed:", err);
          dispatch({ type: "turn/end", outcome: "error", error: "VYRSE lost track of that reply. Try again." });
        } finally {
          if (progressTimer !== null) window.clearTimeout(progressTimer);
          if (abortRef.current === controller) abortRef.current = null;
        }
      })();
    },
    [api, stopMic],
  );

  const cancel = useCallback(() => {
    if (!abortRef.current) return;
    // Busy until Hermes confirms the interrupt, so a new prompt can't race the old turn.
    dispatch({ type: "notice/set", notice: "Stopping…" });
    abortRef.current.abort();
  }, []);

  cancelRef.current = cancel;

  /**
   * Retry the last reply, or resend the last message edited (`text`): Hermes drops the last exchange
   * from the session first, so the history doesn't keep the old attempt.
   */
  const rewind = useCallback(
    async (text?: string) => {
      const st = stateRef.current;
      const active = st.conversations.find((c) => c.id === st.activeId);
      const lastUser = active && [...active.messages].reverse().find((m) => m.role === "user");
      if (!active || !lastUser || st.turn) return;
      const next = (text ?? lastUser.text).trim();
      if (!next) return;
      try {
        await api.conversations?.undo?.(active.id);
      } catch (err) {
        console.warn("[vyrse] undo failed:", err);
        dispatch({ type: "error/set", error: "Hermes couldn't rewind that conversation." });
        return;
      }
      dispatch({ type: "conversation/dropLastTurn", id: active.id });
      send(next);
    },
    [api, send],
  );
  const regenerate = useCallback(() => void rewind(), [rewind]);
  const editLast = useCallback((text: string) => void rewind(text), [rewind]);

  /** Read any reply aloud in full (the speaker button), regardless of the voice-replies setting. */
  const readAloud = useCallback((text: string) => {
    const voice = voiceRef.current;
    if (!voice) return;
    const speaker = voice.speakReply({ followUp: false, full: true });
    speaker.push(`${text}\n`);
    speaker.end();
  }, []);

  const renameConversation = useCallback(
    (id: string, title: string) => {
      const next = title.trim().slice(0, 80);
      if (!next) return;
      dispatch({ type: "conversation/renamed", id, title: next });
      void api.conversations?.rename(id, next).catch((err) => {
        console.warn("[vyrse] rename failed:", err);
        dispatch({ type: "error/set", error: "Hermes couldn't rename that conversation." });
        void refreshList();
      });
    },
    [api, refreshList],
  );

  // --- conversation actions ----------------------------------------------------------
  const selectConversation = useCallback(
    (id: string) => {
      dispatch({ type: "conversation/select", id });
      const c = stateRef.current.conversations.find((x) => x.id === id);
      if (!c?.loaded) void openConversation(id);
    },
    [openConversation],
  );

  const startNew = useCallback(() => {
    abortRef.current?.abort();
    // The Hermes session is created on the first message, so empty conversations never pile up.
    dispatch({ type: "conversation/select", id: null });
  }, []);
  startNewRef.current = startNew;

  const deleteConversation = useCallback(
    (id: string) => {
      dispatch({ type: "conversation/removed", id });
      void api.conversations?.delete(id).catch((err) => {
        console.warn("[vyrse] delete failed:", err);
        dispatch({ type: "error/set", error: "Hermes couldn't delete that conversation." });
        void refreshList();
      });
    },
    [api, refreshList],
  );

  const clearHistory = useCallback(() => startNew(), [startNew]);

  const exportActive = useCallback(() => {
    const active = stateRef.current.conversations.find((c) => c.id === stateRef.current.activeId);
    if (!active) return;
    const lines = [`# ${active.title}`, "", ...active.messages.map((m) => `## ${m.role === "vyrse" ? "VYRSE" : "You"}\n\n${m.text}`)];
    if (IS_PHONE) {
      // The Android WebView can't save downloads: copy it instead.
      void copyText(lines.join("\n\n")).then((ok) =>
        dispatch({ type: "toast/set", toast: ok ? "Conversation copied." : "Couldn't copy the conversation." }),
      );
      return;
    }
    const blob = new Blob([lines.join("\n\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.title.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 64) || "conversation"}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, []);

  // --- settings & modes (same functions for human clicks and Hermes requests) --------
  const setSettings = useCallback(
    (patch: Partial<Settings>) => {
      dispatch({ type: "settings/patch", patch });
      persistPrefs(patch);
    },
    [persistPrefs],
  );

  /** Speak a short confirmation (when voice replies are on) without involving the model. */
  const sayShort = useCallback((line: string) => {
    const voice = voiceRef.current;
    if (!voice || !stateRef.current.settings.voiceResponses) return;
    const speaker = voice.speakReply({ followUp: false });
    speaker.push(`${line}\n`);
    speaker.end();
  }, []);

  const setTalkStyle = useCallback(
    (style: TalkStyle) => {
      dispatch({ type: "settings/patch", patch: { talkStyle: style } });
      persistPrefs({ talkStyle: style });
    },
    [persistPrefs],
  );

  const setMode = useCallback(
    (mode: Settings["mode"]) => {
      dispatch({ type: "settings/patch", patch: { mode } });
      persistPrefs({ mode });
      if (mode === "gaming") {
        void api.ui
          ?.unloadLocalModels()
          .then((n) =>
            dispatch({
              type: "toast/set",
              toast: n ? "Gaming mode — local model unloaded, GPU is free." : "Gaming mode — no local model was loaded.",
            }),
          )
          .catch(() => dispatch({ type: "error/set", error: "Couldn't unload the local model." }));
      } else if (mode === "private") {
        const agent = stateRef.current.agent;
        const current = agent?.models.find((m) => m.model === agent.model && m.provider === agent.provider);
        const local = agent?.models.find((m) => m.local);
        if (current && !current.local && local) setModel(local);
        dispatch({ type: "toast/set", toast: "Private mode — VYRSE stays on models running on this PC." });
      } else {
        dispatch({ type: "toast/set", toast: "Assistant mode." });
      }
    },
    [api, persistPrefs, setModel],
  );

  // "switch to fam mode", "vibe mode off", "gaming mode": applied instantly, never sent to the model.
  const sendOrCommand = useCallback(
    (raw: string, options: SendOptions = {}) => {
      const command = options.attachments?.length ? null : parseStyleCommand(raw);
      if (!command) {
        send(raw, options);
        return;
      }
      if (command.kind === "mode") {
        setMode(command.mode);
      } else {
        setTalkStyle(command.style);
        const line = command.style === "normal" ? "Back to normal." : `${styleLabel(command.style)} mode on.`;
        dispatch({ type: "toast/set", toast: line });
        sayShort(line);
      }
      if (options.voice) voiceRef.current?.replyFinished();
    },
    [send, setMode, setTalkStyle, sayShort],
  );
  sendRef.current = sendOrCommand;

  // --- Hermes controlling the interface ------------------------------------------------
  // Navigation requested mid-reply waits for the reply to finish, so Hermes never cuts off its own answer.
  const deferred = useRef<UiCommand[]>([]);
  const runUiCommand = useCallback(
    (command: UiCommand) => {
      const navigation = command.action === "new_conversation" || command.action === "open_conversation";
      if (navigation && stateRef.current.turn) {
        deferred.current.push(command);
        return;
      }
      switch (command.action) {
        case "prefs":
          dispatch({ type: "settings/patch", patch: command.prefs }); // the plugin already stored them
          break;
        case "open":
          dispatch({ type: "ui/settings", open: command.panel === "settings" });
          dispatch({ type: "ui/history", open: command.panel === "history" });
          dispatch({ type: "ui/expanded", expanded: command.panel === "transcript" });
          break;
        case "new_conversation":
          startNew();
          break;
        case "open_conversation": {
          const match = findConversation(stateRef.current.conversations, command.query);
          if (match) selectConversation(match.id);
          else dispatch({ type: "toast/set", toast: `No conversation matches “${command.query}”.` });
          break;
        }
        case "mode":
          setMode(command.mode);
          break;
        case "model": {
          const models = stateRef.current.agent?.models ?? [];
          // The agent names models loosely ("gemma 3 12b" for gemma-3-12b-q4_k_m): compare letters and digits only.
          const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
          const wanted = loose(command.model);
          const choice =
            models.find((m) => m.model === command.model && (!command.provider || m.provider === command.provider)) ??
            (wanted ? models.find((m) => loose(m.model).includes(wanted)) : undefined);
          if (choice) setModel(choice);
          else dispatch({ type: "toast/set", toast: `Model “${command.model}” isn't available in Hermes.` });
          break;
        }
        case "reasoning":
          setReasoning(command.level);
          break;
        case "notify":
          dispatch({ type: "toast/set", toast: command.text });
          break;
        case "alert": {
          // Said aloud right away (it's what they asked to be told), unless VYRSE is mid-reply.
          playUiSound("alert");
          dispatch({ type: "toast/set", toast: command.text });
          const voice = voiceRef.current;
          if (voice && stateRef.current.settings.voiceResponses && !stateRef.current.turn) {
            const speaker = voice.speakReply({ followUp: false });
            speaker.push(`${command.text}
`);
            speaker.end();
          }
          break;
        }
        case "workspace":
          // Saved by the plugin either way; only show what belongs to the open conversation.
          if (command.op !== "layout" && command.session && command.session !== stateRef.current.activeId) break;
          if (command.op === "show") {
            const before = stateRef.current.workspace.find((a) => a.id === command.artifact.id);
            dispatch({ type: "workspace/show", artifact: command.artifact });
            // Only something new opens the workspace: a live chart updating in place (or a log, a quiz
            // moving on) must not reopen a panel the user just closed.
            const mode = command.layout ?? (!before && stateRef.current.ui.presentation === "compact" ? "split" : null);
            if (mode) dispatch({ type: "ui/presentation", mode });
            workspaceSound(command.artifact, before);
            if (command.focus && command.artifact.id) dispatch({ type: "workspace/focus", id: command.artifact.id });
          } else if (command.op === "focus") {
            dispatch({ type: "workspace/focus", id: command.id || null });
            if (command.id && stateRef.current.ui.presentation === "compact") dispatch({ type: "ui/presentation", mode: "split" });
          } else if (command.op === "remove") dispatch({ type: "workspace/remove", id: command.id });
          else if (command.op === "clear") dispatch({ type: "workspace/clear" });
          else dispatch({ type: "ui/presentation", mode: command.layout });
          break;
        case "desktop_call": {
          // Hermes sends these to whichever VYRSE asked: the PC runs Echo actions itself and relays phone
          // actions to the paired phone; the phone runs phone actions itself and hands Echo actions to the PC.
          const desktop = getDesktopBridge()?.desktop as
            | (NonNullable<ReturnType<typeof getDesktopBridge>>["desktop"] & { phone?: (op: string, args?: Record<string, unknown>) => Promise<unknown> })
            | undefined;
          const run: Promise<unknown> = (
            command.target === "phone"
              ? IS_PHONE
                ? runPhoneAction(command.op, command.args)
                : desktop?.phone
                  ? desktop.phone("command", { action: command.op, args: command.args })
                  : Promise.resolve({ ok: false, error: "No phone is paired with this PC." })
              : IS_PHONE
                ? desktopCallViaPc("alexa", command.op, command.args)
                : desktop?.alexa
                  ? desktop.alexa(command.op, command.args)
                  : Promise.resolve({ ok: false, error: "Alexa needs the VYRSE desktop app." })
          ).catch((err: unknown) => ({ ok: false, error: String(err) }));
          void run.then((result) => api.ui?.answerDesktopCall(command.id, result)).catch((err) =>
            console.warn("[vyrse] desktop call result not delivered:", err),
          );
          break;
        }
        case "confirm":
          // Shown with the clarify card; the answer goes back to the waiting plugin tool.
          dispatch({
            type: "clarify/add",
            prompt: {
              id: `${CONFIRM_PREFIX}${command.id}`,
              conversationId: stateRef.current.activeId,
              questions: [{ qid: "choice", question: command.question, choices: command.choices }],
            },
          });
          break;
      }
    },
    [selectConversation, setMode, setModel, setReasoning, startNew],
  );

  useEffect(() => api.ui?.onCommand((command) => runUiCommand(command)), [api, runUiCommand]);

  useEffect(() => {
    if (state.turn || deferred.current.length === 0) return;
    // Let the finished reply settle on screen first.
    const t = window.setTimeout(() => {
      const queue = deferred.current;
      deferred.current = [];
      queue.forEach(runUiCommand);
    }, 900);
    return () => window.clearTimeout(t);
  }, [state.turn, runUiCommand]);

  const active = useMemo(
    () => state.conversations.find((c) => c.id === state.activeId) ?? null,
    [state.conversations, state.activeId],
  );

  const value: VyrseContextValue = {
    settings: state.settings,
    setSettings,
    resolvedTheme,
    link: state.link,
    restartBackend: useCallback(() => void api.link?.restart(), [api]),
    agent: state.agent,
    setModel,
    setReasoning,
    setApprovalMode,
    setMemoryEnabled,
    setSttModel,
    conversations: state.conversations,
    activeId: state.activeId,
    active,
    selectConversation,
    startNew,
    deleteConversation,
    clearHistory,
    exportActive,
    presenceState: state.presence,
    levelRef,
    phoneWake,
    setPhoneWake,
    prefsLoaded,
    listening: state.listening,
    micLive: state.micLive,
    toggleListening,
    send: sendOrCommand,
    setTalkStyle,
    notify: useCallback((text: string) => dispatch({ type: "toast/set", toast: text }), []),
    regenerate,
    editLast,
    readAloud,
    renameConversation,
    cancel,
    busy: state.turn !== null,
    error: state.error,
    dismissError: useCallback(() => dispatch({ type: "error/set", error: null }), []),
    notice: state.notice,
    testMicrophone: useCallback(async () => (voiceRef.current ? voiceRef.current.testMic(5) : null), []),
    recordVoiceClip: useCallback(
      async (seconds: number, onLevel?: (level: number) => void) => (voiceRef.current ? voiceRef.current.recordClip(seconds, onLevel) : null),
      [],
    ),
    restartWakeWord: useCallback(async () => {
      const v = voiceRef.current;
      if (!v) return;
      await v.disable();
      await v.enable();
    }, []),
    toast: state.toast,
    alarm,
    stopAlarm: stopRinging,
    snoozeAlarm,
    setMode,
    pendingApproval: state.approvals[0] ?? null,
    respondToApproval,
    pendingClarify: state.clarifications[0] ?? null,
    respondToClarify,
    historyOpen: state.ui.historyOpen,
    setHistoryOpen: useCallback((open: boolean) => dispatch({ type: "ui/history", open }), []),
    settingsOpen: state.ui.settingsOpen,
    setSettingsOpen: useCallback((open: boolean) => dispatch({ type: "ui/settings", open }), []),
    expanded: state.ui.expanded,
    setExpanded: useCallback((expanded: boolean) => dispatch({ type: "ui/expanded", expanded }), []),
    presentation: state.ui.presentation,
    workspace: state.workspace,
    workspaceUnseen: state.workspaceUnseen,
    workspaceFocus: state.workspaceFocus,
    focusWorkspaceItem: useCallback((id: string | null) => dispatch({ type: "workspace/focus", id }), []),
    checkWorkspaceItem: useCallback(
      (id: string, index: number, done: boolean) => {
        dispatch({ type: "workspace/check", id, index, done });
        if (done) playUiSound("tick");
        const conversationId = stateRef.current.activeId;
        if (conversationId) void api.ui?.checkWorkspaceItem(conversationId, id, index, done).catch((err) => console.warn("[vyrse] checklist save failed:", err));
      },
      [api],
    ),
    removeWorkspaceItem: useCallback(
      (id: string) => {
        dispatch({ type: "workspace/remove", id });
        const conversationId = stateRef.current.activeId;
        if (conversationId) void api.ui?.removeWorkspaceItem(conversationId, id).catch((err) => console.warn("[vyrse] workspace remove failed:", err));
      },
      [api],
    ),
    clearWorkspace: useCallback(() => {
      dispatch({ type: "workspace/clear" });
      const conversationId = stateRef.current.activeId;
      if (conversationId) void api.ui?.clearWorkspace(conversationId).catch((err) => console.warn("[vyrse] workspace clear failed:", err));
    }, [api]),
    setPresentation: useCallback((mode: PresentationMode) => dispatch({ type: "ui/presentation", mode }), []),
    booted: state.booted,
    mode: active && active.messages.length > 0 ? "conversation" : "landing",
    dispatch,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The interface sound for a workspace item arriving or changing (silent for plain live updates). */
function workspaceSound(next: Artifact, before: Artifact | undefined): void {
  if (next.kind === "scorecard") return playUiSound("result");
  if (next.kind === "log") return next.log?.fresh ? playUiSound("tick-soft") : undefined;
  if (next.kind === "quiz" && before?.quiz && next.quiz) {
    const was = before.quiz.questions.filter((q) => q.correct !== undefined).length;
    const now = next.quiz.questions.filter((q) => q.correct !== undefined);
    if (now.length > was) return playUiSound(now[now.length - 1]!.correct ? "tick" : "wrong");
    return;
  }
  if (next.kind === "picker") return; // the wheel makes its own sounds
  if (!before) playUiSound("arrive");
}

const CONFIRM_PREFIX = "vyrse-confirm:";

export interface SendOptions {
  voice?: boolean;
  /** files the user attached (absolute paths) */
  attachments?: { path: string; name: string }[];
}

/** Caption for the status pill while a tool runs. */
function pillCaption(tool: string): string {
  if (tool.startsWith("browser")) return "In the browser";
  if (tool === "vyrse_desktop") return "Working in your apps";
  if (tool === "computer_use") return "Using your screen";
  if (tool === "vyrse_screen") return "Reading your screen";
  if (tool === "terminal" || tool === "process_manage" || tool === "execute_code") return "Running a command";
  if (["read_file", "write_file", "patch", "search_files"].includes(tool)) return "Going through files";
  if (tool === "memory" || tool === "session_search") return "Checking what I remember";
  if (tool === "vyrse_reminders") return "Setting a reminder";
  if (tool === "vyrse_skills" || tool.startsWith("skill")) return "Looking at skills";
  if (tool === "web_search" || tool === "web_extract") return "Searching the web";
  if (tool === "delegate_task") return "A helper is on it";
  return "Working on it";
}

/** A short, natural progress line for what Hermes is doing right now. */
function progressLine(tool: string | null, n: number): string {
  const t = tool ?? "";
  const doing = t.startsWith("browser")
    ? "I'm in the browser"
    : t === "terminal" || t === "process_manage" || t === "execute_code"
      ? "I'm running that on your PC"
      : t === "computer_use"
        ? "I'm working on your screen"
        : ["read_file", "write_file", "patch", "search_files"].includes(t)
          ? "I'm going through the files"
          : t === "memory" || t === "session_search"
            ? "I'm checking what I remember"
            : t.startsWith("skill")
              ? "I'm looking up how to do that"
              : t === "delegate_task"
                ? "I've got a helper working on part of it"
                : "I'm still thinking it through";
  return n === 1 ? `One moment. ${doing}.` : n === 2 ? `Still on it. ${doing}.` : `Almost there. ${doing}.`;
}

function useMediaQuery(query: string): boolean {
  const getMatch = () => typeof window !== "undefined" && window.matchMedia(query).matches;
  const [matches, setMatches] = useReducer((_: boolean, next: boolean) => next, false, getMatch);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const apply = () => setMatches(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [query]);
  return matches;
}

export function useVyrse() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useVyrse must be used inside VyrseProvider");
  return v;
}
