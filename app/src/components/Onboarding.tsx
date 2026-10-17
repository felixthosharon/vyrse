import { useState } from "react";
import { ArrowRight, Mic, Sparkles } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";

/** Opens Settings on a given page (SettingsPanel listens). */
export function openSettingsPage(page: string) {
  window.dispatchEvent(new CustomEvent("vyrse:open-settings-page", { detail: page }));
}

/**
 * The "get to know you" setup: a fresh conversation where VYRSE interviews the user (the vyrse-setup skill)
 * and saves their answers into its personality. Used by onboarding and by Settings ("redo my setup").
 */
export function startPersonalSetup(v: { startNew: () => void; send: (text: string) => void; setSettingsOpen: (open: boolean) => void }) {
  v.setSettingsOpen(false);
  v.startNew();
  // let the new conversation become the active one before the first message goes out
  window.setTimeout(() => v.send("Let's do my personal setup."), 350);
}

/**
 * First run: VYRSE asks what to call you, offers to learn how you say its name, then offers the personal setup.
 * Shown once, when Hermes has no name saved yet.
 */
export function Onboarding() {
  const { prefsLoaded, settings, setSettings, setSettingsOpen, startNew, send } = useVyrse();
  const [name, setName] = useState("");
  const [step, setStep] = useState<"name" | "voice" | "setup" | "done">("name");
  if (!prefsLoaded || step === "done" || (settings.userName && step === "name")) return null;

  const saveName = () => {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!clean) return;
    setSettings({ userName: clean });
    setStep("voice");
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-background/70 px-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-label="Welcome to VYRSE">
      <div className="liquid-strong relative w-full max-w-[26rem] rounded-[1.75rem] px-6 py-7 vyr-emerge">
        {step === "name" ? (
          <>
            <p className="eyebrow">welcome</p>
            <h2 className="mt-2 font-display text-[22px] text-foreground">Hey, I'm VYRSE.</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">What should I call you?</p>
            <form
              className="mt-5 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                saveName();
              }}
            >
              <input
                autoFocus
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                aria-label="Your name"
                className="liquid relative min-w-0 flex-1 rounded-full px-4 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
              />
              <button type="submit" disabled={!name.trim()} aria-label="Continue" className="liquid relative grid size-11 shrink-0 place-items-center rounded-full text-primary disabled:opacity-40">
                <ArrowRight className="size-4" strokeWidth={1.8} />
              </button>
            </form>
          </>
        ) : step === "voice" ? (
          <>
            <p className="eyebrow">your voice</p>
            <h2 className="mt-2 font-display text-[20px] text-foreground">Nice to meet you, {settings.userName}.</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Say “VYRSE” any time to wake me. I understand most voices out of the box, and I get much better if you
              let me learn how <em>you</em> say it (about a minute).
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setStep("setup");
                  setSettingsOpen(true);
                  window.setTimeout(() => openSettingsPage("voice"), 50);
                }}
                className="liquid relative flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] text-primary"
              >
                <Mic className="size-4" strokeWidth={1.7} /> Teach it my voice
              </button>
              <button type="button" onClick={() => setStep("setup")} className="liquid-hover relative rounded-full px-4 py-2.5 text-[13px] text-muted-foreground hover:text-foreground">
                Later
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="eyebrow">make it yours</p>
            <h2 className="mt-2 font-display text-[20px] text-foreground">Let me get to know you.</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              A quick chat, about two minutes: what you do, what you'll use me for, how you like your answers. I'll
              remember it and set myself up around you. Skip anything you like.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setStep("done");
                  startPersonalSetup({ startNew, send, setSettingsOpen });
                }}
                className="liquid relative flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] text-primary"
              >
                <Sparkles className="size-4" strokeWidth={1.7} /> Let's do it
              </button>
              <button type="button" onClick={() => setStep("done")} className="liquid-hover relative rounded-full px-4 py-2.5 text-[13px] text-muted-foreground hover:text-foreground">
                Later
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
