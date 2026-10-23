import { fileURLToPath } from "node:url";

// Vite runs from the repo root, so point Tailwind at its config explicitly.
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.ts", import.meta.url)) },
    autoprefixer: {},
  },
};
