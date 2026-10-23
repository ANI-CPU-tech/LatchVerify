import type { Config } from "tailwindcss";

// shadcn/ui-style tokens: colors resolve to CSS variables defined per theme in src/index.css.
const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;
const pair = (name: string) => ({ DEFAULT: token(name), foreground: token(`${name}-foreground`) });

export default {
  content: { relative: true, files: ["./index.html", "./src/**/*.{ts,tsx}"] },
  theme: {
    extend: {
      colors: {
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        background: token("background"),
        foreground: token("foreground"),
        muted: pair("muted"),
        // glass: cards over the landscape, see-through by the theme's --surface-alpha.
        card: { ...pair("card"), glass: "hsl(var(--card) / var(--surface-alpha))" },
        primary: pair("primary"),
        accent: pair("accent"),
        destructive: pair("destructive"),
        warning: pair("warning"),
        success: pair("success"),
        info: pair("info"),
        sidebar: pair("sidebar"),
        terminal: { ...pair("terminal"), muted: token("terminal-muted"), accent: token("terminal-accent") },
        art: { sky: token("art-sky"), horizon: token("art-horizon") },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        card: "var(--shadow)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "JetBrains Mono", "Menlo", "monospace"],
        // Retro headings: a monospace face, bold. Local fonts only; the UI loads nothing remote.
        display: ["JetBrains Mono", "IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
