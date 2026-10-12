import type { CapacitorConfig } from "@capacitor/cli";

/**
 * VYRSE for Android: the phone build of this app (vite --mode phone → dist-phone), talking to the PC's
 * phone bridge on the home Wi-Fi. The app is served from http://localhost - still a secure context (so
 * the microphone works) - and talks to the bridge, plain http on the LAN, without mixed-content blocking.
 */
const config: CapacitorConfig = {
  appId: "dev.vyrse.phone",
  appName: "VYRSE",
  webDir: "dist-phone",
  server: { androidScheme: "http" },
  // Edge-to-edge (Android 15+): keep the UI clear of the status and navigation bars.
  android: { adjustMarginsForEdgeToEdge: "auto" },
  backgroundColor: "#0b0f14",
};

export default config;
