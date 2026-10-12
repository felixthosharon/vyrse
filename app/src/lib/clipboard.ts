import { getDesktopBridge } from "@/services/hermes/bridge";

/** Copy text: through the desktop app when there is one (always allowed), else the browser Clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  const desktop = getDesktopBridge()?.desktop;
  if (desktop?.copyText) {
    try {
      return await desktop.copyText(text);
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
