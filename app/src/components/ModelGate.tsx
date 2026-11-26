import { Cloud } from "lucide-react";
import { getVyrseApi } from "@/services";
import type { AgentSettings } from "@/services";
import { useVyrse } from "@/lib/vyrse/store";
import { LocalModels } from "./settings/LocalModels";

/** Opens Settings on a given page (SettingsPanel listens). */
function openSettingsPage(page: string) {
  window.dispatchEvent(new CustomEvent("vyrse:open-settings-page", { detail: page }));
}

/** True while VYRSE has nothing to answer with: Hermes is connected but no model is set or available. */
export function needsModel(agent: AgentSettings | null, canGetModels: boolean): boolean {
  return Boolean(agent && canGetModels && (!agent.model || agent.models.length === 0));
}

/**
 * First run with no AI model (2026-11-27: a friend's fresh install opened on the "get to know you" chat, which
 * couldn't send anything because there was no model). Until one is answering, VYRSE shows this instead: the same
 * model picker as Settings → AI models, with the pick that fits the graphics card marked, the models folder for
 * people who already have a .gguf, and online accounts as the other way in. The first download is switched on by
 * itself; then this goes away and the welcome steps follow.
 */
export function ModelGate() {
  const { agent, settingsOpen, setSettingsOpen } = useVyrse();
  const api = getVyrseApi();
  // Connecting an account happens in Settings: step aside while it's open, come back if it ends with no model.
  if (!needsModel(agent, Boolean(api.localModels)) || settingsOpen) return null;

  return (
    <div
      data-model-gate
      className="fixed inset-0 z-[95] overflow-y-auto bg-background/75 backdrop-blur-[6px]"
      role="dialog"
      aria-modal="true"
      aria-label="Get an AI model"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col justify-center px-4 py-10">
        <div className="liquid-strong relative rounded-[1.75rem] px-[clamp(1.1rem,3vw,1.75rem)] py-7 vyr-emerge">
          <p className="eyebrow">one step first</p>
          <h2 className="mt-2 font-display text-[22px] text-foreground">Give VYRSE a brain.</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            VYRSE thinks with an AI model that runs privately on this PC. Pick one (the one marked
            fits your graphics card best) and it downloads in a few minutes. VYRSE opens as soon as
            it's ready.
          </p>
          <div className="mt-5">
            <LocalModels open firstRun />
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
            <p className="min-w-0 flex-1 basis-48 text-[11.5px] leading-relaxed text-muted-foreground">
              Already pay for ChatGPT, Claude or Gemini, or have an API key? Use that instead.
            </p>
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(true);
                window.setTimeout(() => openSettingsPage("models"), 50);
              }}
              className="liquid relative flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-[12.5px] text-primary"
            >
              <Cloud className="size-4" strokeWidth={1.7} /> Connect an account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
