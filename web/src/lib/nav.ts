/** Keys that move through the section links: the list's own axis, plus Home and End. */
const KEYS = {
  sidebar: { previous: "ArrowUp", next: "ArrowDown" },
  strip: { previous: "ArrowLeft", next: "ArrowRight" },
} as const;

/**
 * Index of the link a key moves to from link `index` of `count`, or null when the key is not a
 * navigation key for this layout. Moves wrap around at both ends.
 */
export function navKeyTarget(key: string, index: number, count: number, layout: keyof typeof KEYS): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === KEYS[layout].next) return (index + 1) % count;
  if (key === KEYS[layout].previous) return (index - 1 + count) % count;
  return null;
}

/**
 * What the page fade does when the route's page becomes `next` while `shown` is on screen:
 * "stay" when it is the page already shown (also when coming back to it mid-fade, which must
 * cancel the fade), "swap" when it changes without motion, "fade" otherwise.
 */
export function pageChange(shown: string, next: string, reducedMotion: boolean): "stay" | "swap" | "fade" {
  if (next === shown) return "stay";
  return reducedMotion ? "swap" : "fade";
}
