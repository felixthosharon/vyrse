import { getDesktopBridge } from "./hermes/bridge";
import { createHermesVyrseApi } from "./hermes/hermes-vyrse-api";
import { createMockVyrseApi } from "./mock-vyrse-api";
import type { VyrseApi } from "./vyrse-api";

let cached: VyrseApi | null = null;

/**
 * Resolves the active adapter once, lazily: Hermes when running inside the VYRSE
 * desktop shell (preload bridge present), the development mock otherwise.
 * UI code imports only this.
 */
export function getVyrseApi(): VyrseApi {
  if (cached) return cached;
  const bridge = getDesktopBridge();
  cached = bridge ? createHermesVyrseApi(bridge) : createMockVyrseApi();
  return cached;
}

export type {
  ApprovalChoice,
  ApprovalPrompt,
  ClarifyPrompt,
  AgentSettings,
  ConversationSummary,
  HubSkill,
  InstalledSkill,
  ModelChoice,
  ReasoningLevel,
  SpeechStream,
  VoiceBackend,
  LinkStatus,
  StreamEvent,
  TurnRequest,
  UiCommand,
  VyrseApi,
} from "./vyrse-api";
