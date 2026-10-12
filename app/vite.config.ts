import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// Plain static Vite build for the Electron renderer — no TanStack Start,
// no Nitro, no server runtime. `tanstackRouter` keeps file-based route
// codegen (src/routeTree.gen.ts) working exactly as before; everything
// else here replaces what @lovable.dev/vite-tanstack-config used to wire
// up (that package pulled in tanstackStart + nitro, which this project no
// longer needs).
/**
 * The phone build talks to the PC's bridge at whatever LAN address the home router gave it
 * (http://192.168.x.x:47630). CSP can't wildcard IP addresses, so there connect-src allows plain
 * http/ws; the bridge itself only answers paired phones from private addresses.
 */
const phoneCsp = (mode: string) => ({
  name: "vyrse-phone-csp",
  transformIndexHtml: (html: string) =>
    mode === "phone"
      ? html.replace("connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*", "connect-src 'self' http: ws:")
      : html,
});

export default defineConfig(({ mode }) => ({
  // Relative asset paths so the built dist/index.html can be opened
  // directly (file://) or served from any subpath by Electron's renderer,
  // with no assumption of a web server or root-mounted origin.
  base: "./",
  plugins: [
    tanstackRouter({ target: "react" }),
    react(),
    tailwindcss(),
    tsConfigPaths(),
    phoneCsp(mode),
  ],
  build: {
    outDir: "dist",
  },
}));
