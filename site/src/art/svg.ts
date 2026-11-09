/**
 * Renders the hero scene as one inline SVG for both site themes. Layers that are the same by day
 * and by night are drawn once; the rest come in a day copy (.art-day) and a night copy
 * (.art-night), and site/src/styles/art.css shows the one that matches the theme. Each color is
 * filled from its --art-* token, so the theme also recolors the shared layers.
 *
 * Runs at build time (site/vite.config.ts inlines the result into the HTML), so the art is there
 * before any script runs.
 */
import { GATE, ROAD, SCENE_COLORS, SCENE_LAYERS, scene, type Layer, type Scene } from "./scene.js";

function paths(layer: Layer): string {
  const d = new Map<string, string>(SCENE_COLORS.map((color) => [color, ""]));
  for (const run of layer.runs) d.set(run.color, `${d.get(run.color)}M${run.x} ${run.y}h${run.w}v1h${-run.w}z`);
  return [...d]
    .filter(([, path]) => path !== "")
    .map(([color, path]) => `<path fill="hsl(var(--art-${color}))" d="${path}"/>`)
    .join("");
}

const same = (a: Layer | undefined, b: Layer | undefined): boolean => JSON.stringify(a?.runs) === JSON.stringify(b?.runs);

/** One group per layer, the portcullis clipped to the arch so it can rise out of sight. */
function group(layer: Layer, time: "day" | "night" | null): string {
  const cls = `art-${layer.name}${time ? ` art-${time}` : ""}`;
  const body = `<g class="${cls}">${paths(layer)}</g>`;
  return layer.name === "portcullis" ? `<g clip-path="url(#lv-arch)">${body}</g>` : body;
}

export function heroSvg(): string {
  const day: Scene = scene("day");
  const night: Scene = scene("night");
  const present = new Set([...day.layers, ...night.layers].map((layer) => layer.name));
  const names = SCENE_LAYERS.filter((name) => present.has(name));

  const groups: string[] = [];
  for (const name of names) {
    const [d, n] = [day.layers.find((l) => l.name === name), night.layers.find((l) => l.name === name)];
    if (same(d, n)) groups.push(group(d!, null));
    else {
      if (d) groups.push(group(d, "day"));
      if (n) groups.push(group(n, "night"));
    }
  }
  const arch = `<clipPath id="lv-arch"><rect x="${GATE.archLeft}" y="${GATE.archTop}" width="${GATE.archRight - GATE.archLeft + 1}" height="${ROAD.bottom - GATE.archTop + 1}"/></clipPath>`;
  return (
    `<svg class="hero-art-svg" viewBox="0 0 ${day.width} ${day.height}" preserveAspectRatio="xMidYMax slice" shape-rendering="crispEdges" aria-hidden="true" focusable="false">` +
    `<defs>${arch}</defs>${groups.join("")}</svg>`
  );
}
