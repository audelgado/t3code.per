import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Run as `vite web` from the plugin root; no PWA plugin: push-only service worker in public/sw.js (no fetch handler, no cache).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:3900" } },
});
