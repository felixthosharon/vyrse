import { useState } from "react";
import { ArrowRight, Mic } from "lucide-react";
import { useVyrse } from "@/lib/vyrse/store";

/** Opens Settings on a given page (SettingsPanel listens). */
export function openSettingsPage(page: string) {
  window.dispatchEvent(new CustomEvent("vyrse:open-settings-page", { detail: page }));
}

/**
 * First run: VYRSE asks what to call you, then offers to learn how you say its name.
 * Shown once, when Hermes has no name saved yet.
 */
export function Onboarding() {
  const { prefsLoaded, settings, setSettings, setSettingsOpen } = useVyrse();
  const [name, setName] = useState("");
  const [step, setStep] = useState<"name" | "voice" | "done">("name");
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
        ) : (
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
                  setStep("done");
                  setSettingsOpen(true);
                  window.setTimeout(() => openSettingsPage("voice"), 50);
                }}
                className="liquid relative flex items-center gap-2 rounded-full px-4 py-2.5 text-[13px] text-primary"
              >
                <Mic className="size-4" strokeWidth={1.7} /> Teach it my voice
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
