import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { getRouter } from "./router";
import "./styles.css";
import { PhonePairing } from "./components/PhonePairing";
import { installPhoneLog } from "./services/phone-log";
import { IS_PHONE, installPhoneBridge, loadPairing, phoneNative, setPhoneLink } from "./services/phone";

const router = getRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element (#root) not found in index.html");
}

// The phone build (Android app) talks to the PC through the phone bridge; until paired it only shows
// the pairing screen.
const phonePairing = IS_PHONE ? loadPairing() : null;
if (phonePairing) {
  installPhoneLog(phonePairing);
  installPhoneBridge(phonePairing);
  // "Let my PC reach this phone" was on: make sure the link runs with this pairing.
  void phoneNative().then((n) =>
    n
      ? n.plugin.status().then(
          (s) => {
            console.info(`phone native: ${JSON.stringify(s)}`);
            if (s.link && !s.linkRunning) void setPhoneLink(true);
          },
          (err: unknown) => console.error("phone native status failed:", err),
        )
      : console.warn("phone native part unavailable"),
  );
}

createRoot(rootElement).render(
  <StrictMode>
    {IS_PHONE && !phonePairing ? <PhonePairing /> : <RouterProvider router={router} />}
  </StrictMode>,
);
