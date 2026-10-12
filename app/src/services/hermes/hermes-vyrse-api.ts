import type { StreamEvent, TurnRequest, VyrseApi } from "../vyrse-api";
import { HermesApprovals } from "./approvals";
import { HermesClarify } from "./clarify";
import type { VyrseBridge } from "./bridge";
import { HermesGateway } from "./gateway";
import { HermesSessions } from "./sessions";
import { HermesSettings } from "./settings";
import { HermesSkills } from "./skills";
import { streamTurn } from "./turns";
import { HermesUiControl } from "./ui-control";
import { HermesReminders } from "./reminders";
import type { FileAttachResult } from "./vendor/gateway-contract.generated";
import { HermesVoice } from "./voice";

/**
 * VyrseApi backed by Hermes Agent (`hermes serve`, started by the desktop shell).
 * Composes the gateway connection with session, turn and approval adapters.
 */
export function createHermesVyrseApi(bridge: VyrseBridge): VyrseApi & { gateway: HermesGateway } {
  const gateway = new HermesGateway(bridge);
  const sessions = new HermesSessions(gateway);
  const approvals = new HermesApprovals(gateway, sessions);
  const clarify = new HermesClarify(gateway, sessions);
  const settings = new HermesSettings(gateway);
  sessions.selectedModel = () => settings.selected;
  const ui = new HermesUiControl(gateway);
  const skills = new HermesSkills(gateway);
  const voice = new HermesVoice(gateway);
  const reminders = new HermesReminders(gateway);

  async function* stream(req: TurnRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    if (!gateway.online) {
      yield { type: "error", message: gateway.state.message || "Hermes isn't connected yet." };
      return;
    }
    let storedId = req.conversationId;
    let liveId: string;
    try {
      if (!storedId) storedId = (await sessions.create()).id;
      liveId = await sessions.liveId(storedId);
      if (settings.selected) {
        // Non-fatal: if it can't be applied, the turn runs on the conversation's current model.
        await sessions.applyModel(liveId, settings.selected).catch((err) => console.warn("[vyrse] model sync failed:", err));
      }
      if (req.reasoning) {
        // Non-fatal: if the level can't be switched the turn still runs at the current one.
        await sessions.applyReasoning(liveId, req.reasoning).catch((err) => console.warn("[vyrse] reasoning switch failed:", err));
      }
    } catch (err) {
      yield { type: "error", message: "Couldn't open this conversation in Hermes.", detail: String(err) };
      return;
    }
    let prompt = req.prompt;
    if (req.attachments?.length) {
      // Images go to the model as pictures when it can see; a model without vision would invent what's
      // in them, so it gets the file plus a nudge to read the image's text instead. Other files are staged
      // into the session and Hermes expands the returned @file refs (text, PDF, Office…).
      const refs: string[] = [];
      const canSee = settings.selected ? await modelCanSee(settings.selected.model) : true;
      for (const path of req.attachments) {
        try {
          if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) {
            if (canSee) {
              await gateway.request("image.attach", { session_id: liveId, path });
              refs.push(`[image: ${path.split(/[\\/]/).pop()}]`);
              continue;
            }
            refs.push(`[image file ${path} — the current model can't see images: read its text with vyrse_screen image="${path}", and say you can't see pictures on this model]`);
            continue;
          }
          const res = await gateway.request<FileAttachResult>("file.attach", { session_id: liveId, path });
          refs.push(res.ref_text);
        } catch (err) {
          yield { type: "error", message: `Couldn't attach ${path.split(/[\\/]/).pop()}.`, detail: String(err) };
          return;
        }
      }
      prompt = `${refs.join(" ")}\n\n${prompt}`;
    }
    yield* streamTurn(gateway, liveId, prompt, signal, { voice: req.voice });
  }

  const vision = new Map<string, boolean>();
  async function modelCanSee(model: string): Promise<boolean> {
    if (vision.has(model)) return vision.get(model)!;
    try {
      const res = await gateway.rest<{ vision?: boolean }>(`/api/plugins/vyrse/model-vision?model=${encodeURIComponent(model)}`);
      vision.set(model, Boolean(res.vision));
      return Boolean(res.vision);
    } catch {
      return true; // unknown: let Hermes decide
    }
  }

  return {
    id: "hermes",
    live: true,
    gateway,
    stream,
    warmUp: () => sessions.warmUp(),
    link: {
      subscribe: (callback) => gateway.subscribe(callback),
      restart: () => gateway.restartBackend(),
    },
    conversations: {
      list: () => sessions.list(),
      create: () => sessions.create(),
      open: (id) => sessions.open(id),
      rename: (id, title) => sessions.rename(id, title),
      undo: (id) => sessions.undo(id),
      delete: (id) => sessions.delete(id),
      onChanged: (callback) => {
        const offs = [gateway.on("sessions.changed", callback), gateway.on("session.title", callback)];
        return () => offs.forEach((off) => off());
      },
    },
    approvals: {
      onRequest: (callback) => approvals.onRequest(callback),
      onCancel: (callback) => approvals.onCancel(callback),
      respond: (id, choice) => approvals.respond(id, choice),
    },
    agent: {
      load: () => settings.load(),
      setModel: (choice, conversationId) =>
        settings.setModel(choice, conversationId ? sessions.peekLiveId(conversationId) : undefined),
      setReasoning: (level) => settings.setReasoning(level),
      setApprovalMode: (mode) => settings.setApprovalMode(mode),
      setMemoryEnabled: (enabled) => settings.setMemoryEnabled(enabled),
      setSttModel: (model) => settings.setSttModel(model),
      onModelChanged: (callback) =>
        gateway.on("session.info", (event) => {
          const info = event.payload as { model?: string; provider?: string } | undefined;
          if (info?.model) callback({ model: info.model, provider: info.provider ?? "" });
        }),
    },
    ui: {
      onCommand: (callback) => ui.onCommand(callback),
      loadPrefs: () => ui.loadPrefs(),
      savePrefs: (patch) => ui.savePrefs(patch),
      wakeTrain: (op) => ui.wakeTrain(op),
      wakeTrainSample: (kind, pcm) => ui.wakeTrainSample(kind, pcm),
      unloadLocalModels: () => ui.unloadLocalModels(),
      answerConfirm: (id, choice) => ui.answerConfirm(id, choice),
      answerDesktopCall: (id, result) => ui.answerDesktopCall(id, result),
      getVoiceMonkey: () => ui.getVoiceMonkey(),
      setVoiceMonkey: (patch) => ui.setVoiceMonkey(patch),
      loadWorkspace: (conversationId) => ui.loadWorkspace(conversationId),
      removeWorkspaceItem: (conversationId, id) => ui.removeWorkspaceItem(conversationId, id),
      clearWorkspace: (conversationId) => ui.clearWorkspace(conversationId),
      checkWorkspaceItem: (conversationId, id, index, done) => ui.checkWorkspaceItem(conversationId, id, index, done),
    },
    voice,
    reminders: {
      list: () => reminders.list(),
      setPaused: (id, paused) => reminders.setPaused(id, paused),
      remove: (id) => reminders.remove(id),
      fired: (since) => reminders.fired(since),
    },
    skills: {
      list: () => skills.list(),
      setEnabled: (name, enabled) => skills.setEnabled(name, enabled),
      content: (name) => skills.content(name),
      search: (query) => skills.search(query),
      install: (identifier) => skills.install(identifier),
      uninstall: (name) => skills.uninstall(name),
    },
    clarify: {
      onRequest: (callback) => clarify.onRequest(callback),
      onCancel: (callback) => clarify.onCancel(callback),
      respond: (id, answers) => clarify.respond(id, answers),
    },
  };
}
