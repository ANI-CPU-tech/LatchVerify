import { useMemo } from "react";
import { ART_COLORS, landscape, type ArtVariant } from "./landscape";

/**
 * The pixel-art landscape as inline SVG: one path per color, filled from the theme's --art-*
 * tokens, crisp edges at any scale. Decorative: hidden from assistive tech and never clickable.
 */
export function PixelLandscape({ variant, className = "" }: { variant: ArtVariant; className?: string }) {
  const { width, height, paths } = useMemo(() => {
    const art = landscape(variant);
    const d = new Map(ART_COLORS.map((color) => [color, ""]));
    for (const run of art.runs) d.set(run.color, `${d.get(run.color)}M${run.x} ${run.y}h${run.w}v1h${-run.w}z`);
    return { width: art.width, height: art.height, paths: [...d].filter(([, path]) => path !== "") };
  }, [variant]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={`pointer-events-none select-none ${className}`}
    >
      {paths.map(([color, d]) => (
        <path key={color} d={d} fill={`hsl(var(--art-${color}))`} />
      ))}
    </svg>
  );
}
