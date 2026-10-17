/**
 * VYRSE on the phone (Android app built with `--mode phone`): the same UI, talking to Hermes on the PC
 * through the VYRSE phone bridge on the home Wi-Fi. Here a small stand-in for the desktop shell's
 * `window.vyrse.backend` points the UI at the bridge with this phone's own key; Hermes' token never
 * reaches the phone (the bridge swaps it in).
 */
import type { VyrseBridge } from "./hermes/bridge";

export const IS_PHONE = import.meta.env.MODE === "phone";

const KEY = "vyrse.phone.v1";

export interface PhonePairing {
  /** http://192.168.x.x:47630 */
  base: string;
  token: string;
  pc: string;
}

export function loadPairing(): PhonePairing | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null") as PhonePairing | null;
    return p?.base && p.token ? p : null;
  } catch {
    return null;
  }
}

export function forgetPairing(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

/** "192.168.1.20" or "192.168.1.20:47630" or a full URL → http://host:port */
export function bridgeBase(address: string): string {
  const a = address.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//.test(a) ? a : `http://${a}`;
  const url = new URL(withScheme);
  if (!url.port) url.port = "47630";
  return `${url.protocol}//${url.host}`;
}

export async function pair(address: string, code: string, name: string): Promise<PhonePairing> {
  const base = bridgeBase(address);
  let res: Response;
  try {
    res = await fetch(`${base}/phone/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim(), name }),
    });
  } catch {
    throw new Error("Can’t reach the PC. Check the address, that VYRSE is open there with phone access on, and that both are on the same Wi-Fi.");
  }
  const body = (await res.json().catch(() => ({}))) as { token?: string; pc?: string; error?: string };
  if (!res.ok || !body.token) throw new Error(body.error ?? `Pairing failed (HTTP ${res.status}).`);
  const pairing = { base, token: body.token, pc: body.pc ?? "PC" };
  localStorage.setItem(KEY, JSON.stringify(pairing));
  return pairing;
}

type Status = Parameters<Parameters<VyrseBridge["backend"]["onStatus"]>[0]>[0];

/** Installs the phone's stand-in for the desktop shell, so the rest of the app runs unchanged. */
export function installPhoneBridge(p: PhonePairing): void {
  // Tighten the page's connect-src from "any http host" (the build can't know the PC's address) to this
  // PC's bridge only: a second CSP is enforced on top of the first, so nothing here can talk to the internet.
  try {
    const origin = new URL(p.base).origin;
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = `connect-src 'self' ${origin} ${origin.replace(/^http/, "ws")}`;
    document.head.appendChild(meta);
  } catch {}
  const wsBase = p.base.replace(/^http/, "ws");
  let last: Status = { phase: "starting", message: `Connecting to ${p.pc}…` };
  const listeners = new Set<(s: Status) => void>();
  const check = async (): Promise<Status> => {
    try {
      const res = await fetch(`${p.base}/phone/ping`, { headers: { "X-Hermes-Session-Token": p.token } });
      if (res.status === 401) {
        return { phase: "failed", message: "This phone was removed on the PC. Pair it again from Settings." };
      }
      const body = (await res.json()) as { hermes?: boolean };
      return body.hermes
        ? { phase: "ready", message: `Connected to ${p.pc}` }
        : { phase: "starting", message: `Hermes is starting on ${p.pc}…` };
    } catch {
      return {
        phase: "restarting",
        message: `Can’t reach ${p.pc}. Is VYRSE open on it, and is this phone on the same Wi-Fi?`,
      };
    }
  };
  const poll = async () => {
    const next = await check();
    if (next.phase !== last.phase || next.message !== last.message) {
      last = next;
      listeners.forEach((l) => l(next));
    }
  };
  void poll();
  window.setInterval(() => void poll(), 4000);
  // Back from the background: check the PC straight away instead of on the next tick.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void poll();
  });

  const backend: VyrseBridge["backend"] = {
    getConnection: async () => ({ baseUrl: p.base, wsUrl: `${wsBase}/api/ws`, token: p.token }),
    getStatus: async () => {
      last = await check();
      return last;
    },
    restart: async () => void poll(),
    onStatus(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  (window as unknown as { vyrse: VyrseBridge }).vyrse = { backend } as VyrseBridge;
}

/* ---------------------------------------------------------------- phone control */

/** The native part of the Android app (android/app/src/main/java/dev/vyrse/phone/VyrsePhonePlugin.java). */
export interface PhoneNativeStatus {
  link: boolean;
  linkRunning: boolean;
  notificationAccess: boolean;
  notificationPermission: boolean;
  accessibility: boolean;
  fullControl: boolean;
}
interface VyrsePhonePlugin {
  run(options: { action: string; args: Record<string, unknown> }): Promise<Record<string, unknown>>;
  startLink(options: { base: string; token: string }): Promise<PhoneNativeStatus>;
  stopLink(): Promise<PhoneNativeStatus>;
  status(): Promise<PhoneNativeStatus>;
  openNotificationAccess(): Promise<void>;
  setFullControl(options: { on: boolean }): Promise<PhoneNativeStatus>;
  openAccessibilitySettings(): Promise<void>;
  openAppInfo(): Promise<void>;
}

/*
 * A Capacitor plugin object answers *every* property, "then" included, so it must never be the value a
 * promise resolves to (the promise would call plugin.then() and never settle). It travels in a box.
 */
let native: Promise<{ plugin: VyrsePhonePlugin } | null> | null = null;
export async function phoneNative(): Promise<{ plugin: VyrsePhonePlugin } | null> {
  native ??= IS_PHONE
    ? import("@capacitor/core").then(({ Capacitor, registerPlugin }) =>
        Capacitor.isNativePlatform() ? { plugin: registerPlugin<VyrsePhonePlugin>("VyrsePhone") } : null,
      )
    : Promise.resolve(null);
  return native;
}

/** Run a phone action here (a request made on the phone itself, e.g. "turn on my flashlight"). */
export async function runPhoneAction(action: string, args: Record<string, unknown>): Promise<unknown> {
  const plugin = (await phoneNative())?.plugin;
  if (!plugin) return { ok: false, error: "Phone actions work in the VYRSE Android app." };
  return plugin.run({ action, args });
}

/** "Let my PC reach this phone": the native link service long-polls the PC bridge for commands. */
export async function setPhoneLink(on: boolean): Promise<PhoneNativeStatus | null> {
  const plugin = (await phoneNative())?.plugin;
  const pairing = loadPairing();
  if (!plugin) return null;
  if (on && pairing) return plugin.startLink({ base: pairing.base, token: pairing.token });
  return plugin.stopLink();
}

/** A PC-only action (the Echo) asked for while chatting on the phone: the PC carries it out. */
export async function desktopCallViaPc(target: string, op: string, args: Record<string, unknown>): Promise<unknown> {
  const p = loadPairing();
  if (!p) return { ok: false, error: "This phone isn't paired with the PC." };
  try {
    const res = await fetch(`${p.base}/phone/desktop-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hermes-Session-Token": p.token },
      body: JSON.stringify({ target, op, args }),
    });
    return await res.json();
  } catch {
    return { ok: false, error: "Couldn't reach the PC for that." };
  }
}

/** Snap: a photo from the phone's camera goes to the PC, where VYRSE looks at it on the big screen. */
export async function snapToPc(file: File): Promise<{ ok: boolean; error?: string }> {
  const p = loadPairing();
  if (!p) return { ok: false, error: "This phone isn't paired with the PC." };
  try {
    const body = await shrink(file, 1800);
    const res = await fetch(`${p.base}/phone/snap`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg", "X-Hermes-Session-Token": p.token },
      body,
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return res.ok && out.ok ? { ok: true } : { ok: false, error: out.error ?? "The PC didn't take it." };
  } catch {
    return { ok: false, error: "Couldn't reach the PC. Is it on the same Wi-Fi?" };
  }
}

/** Camera photos are huge: send at most `max` px on the long side, as JPEG. */
async function shrink(file: File, max: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("photo"))), "image/jpeg", 0.86));
}
