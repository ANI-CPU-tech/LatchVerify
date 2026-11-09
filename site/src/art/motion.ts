/**
 * The hero's message timeline: when each envelope and parcel travels the road, when the poisoned
 * envelope is stopped and when the portcullis drops. It is data (TRIPS, GATE_CLOSED) so tests can
 * check it, and sceneStyles() turns it into CSS keyframes for the layers scene.ts draws.
 *
 * Everything runs on one loop of CYCLE seconds. A sprite moves one art pixel per step, so it stays
 * on the pixel grid. Without motion (prefers-reduced-motion), sprites stay hidden and the
 * portcullis stays up: the still scene is complete on its own.
 */
import { COTTAGE_DOOR, GATE, MESSAGE_WIDTH, PORTCULLIS_TRAVEL, TOWER_DOOR, type SceneLayer } from "./scene.js";

/** Art pixels per second. */
export const SPEED = 30;
/** Length of the loop, in seconds. */
export const CYCLE = 36;

export interface Trip {
  layer: Extract<SceneLayer, `msg-${string}`>;
  /** Left edge where the sprite starts (scene.ts draws it there) and ends. */
  from: number;
  to: number;
  /** Seconds into the loop. */
  start: number;
  /** Seconds it waits at `to` before it fades, for the stopped envelope. */
  hold?: number;
}

const BLOCKED_AT = 19;
const ARRIVES = BLOCKED_AT + (COTTAGE_DOOR < GATE.stop ? GATE.stop - COTTAGE_DOOR : 0) / SPEED;
const HOLD = 3.5;

export const TRIPS: readonly Trip[] = [
  { layer: "msg-q1", from: COTTAGE_DOOR, to: TOWER_DOOR, start: 0 },
  { layer: "msg-q2", from: COTTAGE_DOOR, to: TOWER_DOOR, start: 4 },
  { layer: "msg-a1", from: TOWER_DOOR, to: COTTAGE_DOOR, start: 12.2 },
  { layer: "msg-a2", from: TOWER_DOOR, to: COTTAGE_DOOR, start: 16.2 },
  { layer: "msg-bad", from: COTTAGE_DOOR, to: GATE.stop, start: BLOCKED_AT, hold: HOLD },
  { layer: "msg-err", from: GATE.stop, to: COTTAGE_DOOR, start: ARRIVES + HOLD + 0.3 },
];

/** When the portcullis is down, in seconds: it drops as the poisoned envelope arrives. */
export const GATE_CLOSED = { from: ARRIVES, to: ARRIVES + HOLD + 0.8 } as const;
/** How long the portcullis takes to drop or rise. */
const GATE_MOVE = 0.4;

export const tripEnd = (trip: Trip): number => trip.start + Math.abs(trip.to - trip.from) / SPEED;

/** The seconds during which a trip's sprite overlaps the gatehouse, or null if it never does. */
export function inGate(trip: Trip): { from: number; to: number } | null {
  const [lo, hi] = [GATE.left - MESSAGE_WIDTH + 1, GATE.right];
  const at = (x: number) => trip.start + Math.abs(x - trip.from) / SPEED;
  const [a, b] = [Math.min(trip.from, trip.to), Math.max(trip.from, trip.to)];
  if (b < lo || a > hi) return null;
  const [enter, leave] = trip.to > trip.from ? [Math.max(a, lo), Math.min(b, hi)] : [Math.min(b, hi), Math.max(a, lo)];
  return { from: at(enter), to: at(leave) };
}

const pct = (seconds: number): string => `${+((seconds / CYCLE) * 100).toFixed(3)}%`;
/** A hair, so a sprite appears and vanishes between two frames rather than fading. */
const EPSILON = 0.02;

function tripKeyframes(trip: Trip): string {
  const dx = trip.to - trip.from;
  const end = tripEnd(trip);
  const gone = end + (trip.hold ?? 0);
  const frames = [
    `0% { opacity: 0; transform: translateX(0); }`,
    `${pct(Math.max(0, trip.start - EPSILON))} { opacity: 0; transform: translateX(0); }`,
    `${pct(trip.start)} { opacity: 1; transform: translateX(0); animation-timing-function: steps(${Math.abs(dx)}, end); }`,
    `${pct(end)} { opacity: 1; transform: translateX(${dx}px); }`,
    `${pct(gone)} { opacity: 1; transform: translateX(${dx}px); }`,
    `${pct(gone + (trip.hold ? 0.3 : EPSILON))} { opacity: 0; transform: translateX(${dx}px); }`,
    `100% { opacity: 0; transform: translateX(${dx}px); }`,
  ];
  return `@keyframes lv-${trip.layer} { ${frames.join(" ")} }`;
}

/** The exclamation mark blinks over the stopped envelope while it waits. */
function alarmKeyframes(): string {
  const trip = TRIPS.find((t) => t.hold)!;
  const [from, to] = [tripEnd(trip), tripEnd(trip) + trip.hold!];
  const frames = [`0% { opacity: 0; }`, `${pct(from - EPSILON)} { opacity: 0; }`];
  for (let t = from, on = true; t < to; t += 0.35, on = !on) frames.push(`${pct(t)} { opacity: ${on ? 1 : 0}; animation-timing-function: steps(1, end); }`);
  frames.push(`${pct(to)} { opacity: 0; }`, `100% { opacity: 0; }`);
  return `@keyframes lv-alarm { ${frames.join(" ")} }`;
}

function portcullisKeyframes(): string {
  const up = `translateY(-${PORTCULLIS_TRAVEL}px)`;
  const steps = `animation-timing-function: steps(${PORTCULLIS_TRAVEL}, end);`;
  return `@keyframes lv-portcullis { 0% { transform: ${up}; } ${pct(GATE_CLOSED.from - GATE_MOVE)} { transform: ${up}; ${steps} } ${pct(GATE_CLOSED.from)} { transform: translateY(0); } ${pct(GATE_CLOSED.to)} { transform: translateY(0); ${steps} } ${pct(GATE_CLOSED.to + GATE_MOVE)} { transform: ${up}; } 100% { transform: ${up}; } }`;
}

/**
 * CSS for the message timeline, scoped to `scope` (the hero's art container). Sprites are hidden
 * and the portcullis raised by default; the loop runs only for viewers who have not asked for
 * less motion.
 */
export function sceneStyles(scope: string): string {
  const sprites = [...TRIPS.map((trip) => `.art-${trip.layer}`), ".art-alarm"].map((s) => `${scope} ${s}`).join(", ");
  const loops = TRIPS.map((trip) => `${scope} .art-${trip.layer} { animation: lv-${trip.layer} ${CYCLE}s linear infinite; }`);
  return [
    `${sprites} { opacity: 0; }`,
    `${scope} .art-portcullis { transform: translateY(-${PORTCULLIS_TRAVEL}px); }`,
    "@media (prefers-reduced-motion: no-preference) {",
    ...loops,
    `${scope} .art-alarm { animation: lv-alarm ${CYCLE}s linear infinite; }`,
    `${scope} .art-portcullis { animation: lv-portcullis ${CYCLE}s linear infinite; }`,
    ...TRIPS.map(tripKeyframes),
    alarmKeyframes(),
    portcullisKeyframes(),
    "}",
  ].join("\n");
}
