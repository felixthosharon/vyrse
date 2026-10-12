import { useEffect, useState } from "react";
import { getDesktopBridge } from "@/services/hermes/bridge";
import { forgetPairing, IS_PHONE, loadPairing, phoneNative, setPhoneLink, type PhoneNativeStatus } from "@/services/phone";
import { Section, SwitchRow, Toggle } from "./controls";

interface PhoneStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  addresses: string[];
  devices: { id: string; name: string; created: number; lastSeen: number; linked?: boolean }[];
  pairing: { code: string; expiresIn: number } | null;
  error?: string;
}

type PhoneApi = {
  phone(op: string, args?: Record<string, unknown>): Promise<unknown>;
  onPhoneStatus(callback: (s: PhoneStatus) => void): () => void;
};

const button =
  "liquid-hover relative rounded-full border border-border/70 px-3 py-1.5 text-[11.5px] text-foreground disabled:opacity-50 focus-visible:outline-none";

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Settings → Phone: VYRSE on an Android phone over the home Wi-Fi (the model stays on this PC). */
export function PhoneSection() {
  if (IS_PHONE) return <PhoneSide />;
  return <PcSide />;
}

function PhoneSide() {
  const p = loadPairing();
  const [native, setNative] = useState<PhoneNativeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const refresh = () => void phoneNative().then((n) => n?.plugin.status().then(setNative));
    refresh();
    // Back from Android's settings screen: show the new notification-access state.
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);

  return (
    <Section title="Phone">
      <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
        <span className="block text-[12.5px] text-foreground">Connected to {p?.pc ?? "your PC"}</span>
        <span className="block pt-0.5 font-mono text-[10px] text-muted-foreground">{p?.base}</span>
        <button
          type="button"
          className={`${button} mt-3`}
          onClick={() => {
            void setPhoneLink(false);
            forgetPairing();
            window.location.reload();
          }}
        >
          Disconnect this phone
        </button>
      </div>
      {native && (
        <>
          <SwitchRow
            label="Let my PC reach this phone"
            hint="ask VYRSE on the PC (or here) to ring it, use the flashlight, play/pause, read notifications · works in the background on home Wi-Fi"
            checked={native.link}
            onChange={async (on) => {
              setBusy(true);
              const next = await setPhoneLink(on);
              if (next) setNative(next);
              setBusy(false);
            }}
          />
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-surface/40 px-3 py-2.5">
            <div className="min-w-0">
              <span className="block text-[12.5px] text-foreground">Notification access</span>
              <span className="block pt-0.5 text-[10px] text-muted-foreground">
                {native.notificationAccess
                  ? "Allowed — VYRSE can read your notifications when you ask"
                  : "Off — needed for “any new messages?”. Android asks you to turn VYRSE on in a list."}
              </span>
            </div>
            {!native.notificationAccess && (
              <button type="button" disabled={busy} className={button} onClick={() => void phoneNative().then((n) => n?.plugin.openNotificationAccess())}>
                Allow
              </button>
            )}
          </div>
          <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="block text-[12.5px] text-foreground">Full control</span>
                <span className="block pt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                  {native.accessibility
                    ? native.fullControl
                      ? "On: VYRSE can see the screen, tap, type, swipe and open apps when you ask. A glowing border shows while it acts; “Stop control” is in the notification."
                      : "Ready. Turn on to let VYRSE operate this phone when you ask."
                    : "Step 1: turn on VYRSE in Android's Accessibility settings. If it's greyed out, open App info → ⋮ → Allow restricted settings first."}
                </span>
              </div>
              {native.accessibility ? (
                <Toggle
                  checked={native.fullControl}
                  label="Full control"
                  onChange={async (on) => {
                    const next = await phoneNative().then((n) => n?.plugin.setFullControl({ on }));
                    if (next) setNative(next);
                  }}
                />
              ) : (
                <div className="flex shrink-0 flex-col gap-1.5">
                  <button type="button" className={button} onClick={() => void phoneNative().then((n) => n?.plugin.openAccessibilitySettings())}>
                    Accessibility
                  </button>
                  <button type="button" className={button} onClick={() => void phoneNative().then((n) => n?.plugin.openAppInfo())}>
                    App info
                  </button>
                </div>
              )}
            </div>
            <p className="pt-2 text-[10px] leading-relaxed text-muted-foreground">
              Never in payment, banking or password apps or password fields. Sending, paying, deleting, installing or
              calling always asks you first on the PC.
            </p>
          </div>
        </>
      )}
    </Section>
  );
}

function PcSide() {
  const desktop = getDesktopBridge()?.desktop as (PhoneApi & object) | undefined;
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [left, setLeft] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop?.phone) return;
    void desktop.phone("status").then((s) => setStatus(s as PhoneStatus));
    return desktop.onPhoneStatus?.(setStatus);
  }, [desktop]);

  // Countdown for the pairing code.
  useEffect(() => {
    if (!status?.pairing) return setLeft(0);
    const end = Date.now() + status.pairing.expiresIn * 1000;
    const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [status?.pairing]);

  if (!desktop?.phone) return null;
  const call = async (op: string, args?: Record<string, unknown>) => setStatus((await desktop.phone(op, args)) as PhoneStatus);

  return (
    <Section title="Phone">
      <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-[12.5px] text-foreground">Phone access</span>
            <span className="block pt-0.5 text-[10px] text-muted-foreground">
              {status?.error ?? (status?.running ? "On — paired phones on your home Wi-Fi can use VYRSE" : "Off")}
            </span>
          </div>
          <Toggle checked={Boolean(status?.enabled)} onChange={(on) => void call(on ? "enable" : "disable")} label="Phone access" />
        </div>
        <p className="pt-2 text-[10px] leading-relaxed text-muted-foreground">
          The model keeps running on this PC; the VYRSE app on your Android phone connects over your home Wi-Fi. Only
          phones you pair here get in, and only from your home network.
        </p>
      </div>

      {status?.enabled && (
        <>
          <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
            <span className="block text-[12.5px] text-foreground">Allow on home Wi-Fi (one time)</span>
            <span className="block pt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              Windows has your Wi-Fi set as a Public network, which blocks phones. This marks it Private and allows only
              VYRSE&apos;s phone port from your local network. Windows will ask for permission.
            </span>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className={button}
                onClick={async () => {
                  const r = (await desktop.phone("allowFirewall")) as { ok: boolean };
                  setNote(r.ok ? "Done — home Wi-Fi allowed." : "Windows didn’t allow it (permission declined?).");
                }}
              >
                Allow
              </button>
              {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
            </div>
          </div>

          <div className="rounded-2xl border border-border/70 bg-surface/40 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-foreground">Pair a phone</span>
              {status.pairing && left > 0 ? (
                <button type="button" className={button} onClick={() => void call("cancelPair")}>
                  Cancel
                </button>
              ) : (
                <button type="button" className={button} onClick={() => void call("pair")}>
                  Pair a phone
                </button>
              )}
            </div>
            {status.pairing && left > 0 && (
              <div className="mt-3 grid gap-2">
                <div className="liquid relative rounded-2xl px-4 py-3 text-center">
                  <span className="eyebrow block">address</span>
                  <span className="block pt-1 font-mono text-[18px] text-foreground">{status.addresses[0] ?? "no Wi-Fi address"}</span>
                  <span className="eyebrow block pt-3">code</span>
                  <span className="block pt-1 font-mono text-[28px] tracking-[0.3em] text-primary">{status.pairing.code}</span>
                  <span className="block pt-1 text-[10px] text-muted-foreground">expires in {left}s</span>
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  Open the VYRSE app on your phone and enter these.
                  {status.addresses.length > 1 ? ` Other addresses for this PC: ${status.addresses.slice(1).join(", ")}.` : ""}
                </p>
              </div>
            )}
            {status.devices.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {status.devices.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">{d.name}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {d.linked ? "reachable now · phone actions work" : `last seen ${ago(d.lastSeen)}`}
                      </span>
                    </span>
                    <button type="button" className={button} onClick={() => void call("remove", { id: d.id })}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
