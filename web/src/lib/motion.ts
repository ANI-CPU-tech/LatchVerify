/** Small motion helpers, kept pure so tests/web can check them in node. */

/** Ease-out cubic on t in [0, 1]: fast start, gentle landing. Outside the range it clamps. */
export const easeOutCubic = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** The whole number shown `elapsed` ms into counting from `from` to `to` over `duration` ms. */
export function countFrame(from: number, to: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return to;
  return Math.round(from + (to - from) * easeOutCubic(elapsed / duration));
}
