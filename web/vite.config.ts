import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  plugins: [react()],
  resolve: {
    // Shared zod schemas/types live in src/schema/, outside the web root.
    alias: { "@schema": here("../src/schema") },
  },
  server: {
    port: 5173,
    // The hono review API (src/ui/server.ts) listens on LATCH_UI_PORT.
    proxy: { "/api": `http://127.0.0.1:${process.env.LATCH_UI_PORT ?? 7777}` },
    fs: { allow: [here("..")] },
  },
  build: {
    outDir: here("../dist/web"),
    emptyOutDir: true,
  },
});
