/// <reference lib="webworker" />
/**
 * The orb, drawn off the UI thread (phone app): the page hands over its canvas once
 * (transferControlToOffscreen) and then only sends the live inputs each frame.
 */
import { createPresence, type PresenceHandle, type PresenceParams } from "./presence-engine";

let handle: PresenceHandle | null = null;

type Message =
  | { type: "init"; canvas: OffscreenCanvas; params: PresenceParams; width: number; height: number }
  | { type: "params"; params: Partial<PresenceParams> }
  | { type: "size"; width: number; height: number }
  | { type: "destroy" };

self.onmessage = (event: MessageEvent<Message>) => {
  const msg = event.data;
  if (msg.type === "init") {
    handle = createPresence(msg.canvas, msg.params);
    handle.setSize(msg.width, msg.height);
  } else if (!handle) return;
  else if (msg.type === "params") Object.assign(handle.params, msg.params);
  else if (msg.type === "size") handle.setSize(msg.width, msg.height);
  else if (msg.type === "destroy") {
    handle.destroy();
    handle = null;
    self.close();
  }
};
