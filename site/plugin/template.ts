/**
 * Build-time HTML for the site (site/vite.config.ts runs it on every page):
 *
 * - <!--lv:hero-art--> becomes the hero scene's SVG and <!--lv:hero-motion--> its message timeline,
 * - <!--lv:splash--> becomes the loading screen (src/art/padlock.ts),
 * - <i data-icon="name"></i> becomes that pixel icon,
 * - {{release.*}} and {{file.<kind>.*}} become the release's data, so the download links work
 *   before, and without, any script. src/ui/downloads.ts refreshes the same fields in the browser.
 *
 * An unknown placeholder or icon name fails the build rather than shipping a broken page.
 */
import { heroSvg } from "../src/art/svg.js";
import { sceneStyles } from "../src/art/motion.js";
import { iconSvg, isIconName } from "../src/art/icons.js";
import { splashHtml } from "../src/art/padlock.js";
import { releaseFields, type Release } from "../src/lib/release.js";

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let art: { svg: string; motion: string } | undefined;

export function renderPage(html: string, release: Release): string {
  const fields = releaseFields(release);
  art ??= { svg: heroSvg(), motion: `<style id="hero-motion">${sceneStyles(".hero-art")}</style>` };
  const { svg, motion } = art;
  // Placeholders first, so nothing inserted afterwards can be mistaken for one. Replacer
  // functions throughout, so a "$" in the inserted text is never read as a pattern.
  const page = html
    .replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => {
      const value = fields.get(key);
      if (value === undefined) throw new Error(`unknown placeholder {{${key}}}`);
      return escapeHtml(value);
    })
    .replace(/<i data-icon="([\w-]+)"(?: class="([\w -]+)")?><\/i>/g, (_, name: string, className?: string) => {
      if (!isIconName(name)) throw new Error(`unknown icon "${name}"`);
      return iconSvg(name, className);
    });
  const leftover = /<[^>]*data-icon=[^>]*>/.exec(page);
  if (leftover) throw new Error(`icon placeholder not in the form <i data-icon="name" class="..."></i>: ${leftover[0]}`);
  return page
    .replace("<!--lv:hero-art-->", () => svg)
    .replace("<!--lv:hero-motion-->", () => motion)
    .replace("<!--lv:splash-->", () => splashHtml())
    .replace("</body>", () => `${releaseScript(release)}</body>`);
}

/** The release data the browser starts from, embedded as JSON (read by src/ui/downloads.ts). */
export function releaseScript(release: Release): string {
  // "<" escaped so the JSON can never close the script element.
  return `<script type="application/json" id="lv-release">${JSON.stringify(release).replace(/</g, "\\u003c")}</script>`;
}
