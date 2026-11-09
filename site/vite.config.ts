/**
 * The showcase site: static pages built by Vite, no framework. `pnpm site:dev` serves it with hot
 * reload, `pnpm site:build` writes site/dist for GitHub Pages (.github/workflows/site.yml).
 *
 * Each page goes through plugin/template.ts, which inlines the hero art and the pixel icons and
 * fills in the latest release. The release comes from the GitHub API when it answers; otherwise
 * from package.json's version, with the file names the release workflow gives each package.
 * SITE_OFFLINE=1 skips the API; GITHUB_TOKEN, when set (as in CI), avoids its rate limit.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { archVersion, debVersion } from "../packaging/version.js";
import { renderPage } from "./plugin/template.js";
import { LATEST_RELEASE_API, derivedRelease, parseRelease, type Release } from "./src/lib/release.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

async function latestRelease(): Promise<Release> {
  const { version } = JSON.parse(readFileSync(here("../package.json"), "utf8")) as { version: string };
  const derived = derivedRelease(version, { deb: debVersion(version), arch: archVersion(version) });
  if (process.env.SITE_OFFLINE === "1") return derived;
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "latchverify-site-build" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch(LATEST_RELEASE_API, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = parseRelease(await response.json());
    if (!release) throw new Error("the answer is not a published release");
    console.info(`[site] linking downloads to v${release.version} (GitHub API)`);
    return release;
  } catch (error) {
    console.warn(`[site] could not read the latest release (${(error as Error).message}); linking downloads to v${version} by file name`);
    return derived;
  }
}

function sitePages(): Plugin {
  let release: Promise<Release> | undefined;
  return {
    name: "latchverify-site-pages",
    transformIndexHtml: {
      order: "pre",
      handler: async (html) => renderPage(html, await (release ??= latestRelease())),
    },
  };
}

export default defineConfig({
  root: here("."),
  // GitHub Pages serves the repository's site under /LatchVerify/; SITE_BASE overrides it (for a custom domain, "/").
  base: process.env.SITE_BASE ?? "/LatchVerify/",
  publicDir: here("public"),
  plugins: [sitePages()],
  server: { port: 5180 },
  preview: { port: 5181 },
  build: {
    outDir: here("dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: here("index.html"),
        download: here("download/index.html"),
        notFound: here("404.html"),
      },
    },
  },
});
