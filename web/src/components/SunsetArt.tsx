/**
 * Sunset over mountains, drawn in theme tokens. Decorative: used once, on Overview, and left out
 * by the Minimal theme (.latch-art in index.css).
 */
export function SunsetArt({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 120" aria-hidden="true" focusable="false" className={`latch-art ${className}`}>
      <circle cx="214" cy="62" r="34" fill="hsl(var(--accent))" />
      <path d="M0 120 L70 52 L104 82 L150 34 L204 92 L238 66 L320 120 Z" fill="hsl(var(--primary) / 0.55)" />
      <path d="M0 120 L46 86 L88 104 L140 66 L196 108 L262 78 L320 104 L320 120 Z" fill="hsl(var(--foreground) / 0.75)" />
      <path d="M150 34 L162 46 L154 44 L146 50 L140 44 Z" fill="hsl(var(--card))" opacity="0.85" />
      {[
        [258, 120, 16],
        [276, 120, 22],
        [294, 120, 14],
        [30, 120, 18],
      ].map(([x, base, h]) => (
        <path key={x} d={`M${x} ${base! - h!} L${x! - 6} ${base} L${x! + 6} ${base} Z`} fill="hsl(var(--foreground) / 0.9)" />
      ))}
    </svg>
  );
}
