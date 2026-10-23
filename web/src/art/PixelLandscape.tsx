import { useMemo } from "react";
import { ART_COLORS, landscape, starrySky, type ArtExtra, type ArtTime, type PixelArt } from "./landscape";

/**
 * Pixel art as inline SVG: one <g> per layer, classed .art-<layer> so index.css can animate it,
 * holding one path per color filled from the theme's --art-* tokens, crisp edges at any scale.
 * Decorative: hidden from assistive tech and never clickable. Anchored at the bottom: shown
 * whole at its own aspect ratio, or, in a box of another shape, cropped.
 */
function PixelSvg({ art, className }: { art: PixelArt; className: string }) {
  const layers = useMemo(
    () =>
      art.layers.map((layer) => {
        const d = new Map(ART_COLORS.map((color) => [color, ""]));
        for (const run of layer.runs) d.set(run.color, `${d.get(run.color)}M${run.x} ${run.y}h${run.w}v1h${-run.w}z`);
        return { name: layer.name, paths: [...d].filter(([, path]) => path !== "") };
      }),
    [art],
  );

  return (
    <svg
      viewBox={`0 0 ${art.width} ${art.height}`}
      preserveAspectRatio="xMidYMax slice"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={`pointer-events-none select-none ${className}`}
    >
      {layers.map(({ name, paths }) => (
        <g key={name} className={`art-${name}`}>
          {paths.map(([color, d]) => (
            <path key={color} d={d} fill={`hsl(var(--art-${color}))`} />
          ))}
        </g>
      ))}
    </svg>
  );
}

export function PixelLandscape({ time = "day", extra = null, className = "" }: { time?: ArtTime; extra?: ArtExtra | null; className?: string }) {
  const art = useMemo(() => landscape(time, extra), [time, extra]);
  return <PixelSvg art={art} className={className} />;
}

/** Stars for the sky above the night landscape; sized like it so the two line up. */
export function StarrySky({ className = "" }: { className?: string }) {
  const art = useMemo(() => starrySky(), []);
  return <PixelSvg art={art} className={className} />;
}
