/**
 * The loading screen's padlock: the site's logo (web/public/favicon.svg, a 16x16 padlock with a
 * sunset in its body) as bitmaps, with the shackle drawn open. Dropped three pixels it lands exactly
 * on the logo's closed shackle (the body covers the rest of its right leg), so locking is one move.
 * "o" is the outline, drawn in the theme's foreground so it shows on both themes; a to d are the
 * logo's own sunset colors. site/plugin/template.ts inlines splashHtml() where a page has
 * <!--lv:splash-->; src/ui/splash.ts runs it.
 */

export const PADLOCK_COLORS = { a: "#f8aa6e", b: "#f06423", c: "#c86e4b", d: "#5d3e2c" } as const;

/** The body, rows 6 to 14 of the logo. */
export const BODY = [
  "..oooooooooooo..",
  "..oaaaaaaaaaao..",
  "..oaaaaabbaaao..",
  "..oaaaabbbbaao..",
  "..oacaabbbbcao..",
  "..occcabbbccco..",
  "..occccccccdco..",
  "..oddccccddddo..",
  "..oooooooooooo..",
] as const;

/** The closed shackle, rows 1 to 5 of the logo: where the open one lands. */
export const SHACKLE_CLOSED = [
  ".....oooooo.....",
  "....oo....oo....",
  "....o......o....",
  "....o......o....",
  "....o......o....",
] as const;

/** The open shackle, three rows higher: its left leg free, its right leg still in the body. */
export const SHACKLE_OPEN = [
  ".....oooooo.....",
  "....oo....oo....",
  "....o......o....",
  "....o......o....",
  "....o......o....",
  "...........o....",
  "...........o....",
  "...........o....",
] as const;

/** Paths for a bitmap whose top row is at `top`, one path per color. */
function paths(rows: readonly string[], top: number): string {
  const d = new Map<string, string>();
  rows.forEach((row, y) => {
    for (const match of row.matchAll(/([oabcd])\1*/g)) {
      const key = match[1]!;
      d.set(key, `${d.get(key) ?? ""}M${match.index} ${top + y}h${match[0].length}v1h-${match[0].length}z`);
    }
  });
  return [...d]
    .map(([key, path]) => `<path fill="${key === "o" ? "hsl(var(--foreground))" : PADLOCK_COLORS[key as keyof typeof PADLOCK_COLORS]}" d="${path}"/>`)
    .join("");
}

/** The loading screen. Decorative: the page under it is already readable by assistive tech. */
export function splashHtml(): string {
  const lock =
    `<svg class="splash-lock" viewBox="0 -3 16 19" shape-rendering="crispEdges" aria-hidden="true" focusable="false">` +
    `<g class="splash-shackle-open">${paths(SHACKLE_OPEN, -2)}</g>` +
    `<g class="splash-body">${paths(BODY, 6)}</g>` +
    `</svg>`;
  return (
    `<div class="splash" id="splash" aria-hidden="true">` +
    `<div class="splash-inner">${lock}<p class="splash-name">LatchVerify</p>` +
    `<div class="splash-bar"><div class="splash-fill"></div></div></div></div>`
  );
}
