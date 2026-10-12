import { AlarmClock, BellOff, TimerReset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVyrse } from "@/lib/vyrse/store";

/** An alarm ringing: the time, Stop and Snooze. It keeps ringing (softly swelling) until one is pressed. */
export function AlarmCard() {
  const { alarm, stopAlarm, snoozeAlarm } = useVyrse();
  if (!alarm) return null;
  const time = alarm.name.replace(/^Alarm\s*·?\s*/, "") || "Alarm";
  return (
    <div role="alertdialog" aria-label={`Alarm ${time}`} className="fixed inset-0 z-50 grid place-items-center bg-background/55 px-4 backdrop-blur-sm">
      <div className="vyr-emerge liquid relative w-full max-w-sm rounded-3xl px-7 pb-6 pt-7 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-primary/40 bg-primary/10 text-primary shadow-[0_0_40px_-6px_var(--color-primary)]">
          <AlarmClock className="size-7 animate-pulse" strokeWidth={1.7} />
        </div>
        <p className="mt-5 font-mono text-[10.5px] uppercase tracking-[0.24em] text-muted-foreground">Alarm</p>
        <p className="mt-1 font-display text-5xl font-semibold tracking-tight text-foreground">{time}</p>
        <div className="mt-6 flex gap-2">
          <Button className="flex-1" size="lg" onClick={stopAlarm} autoFocus>
            <BellOff className="size-4" /> Stop
          </Button>
          <Button className="flex-1" size="lg" variant="outline" onClick={snoozeAlarm}>
            <TimerReset className="size-4" /> Snooze 9 min
          </Button>
        </div>
      </div>
    </div>
  );
}
