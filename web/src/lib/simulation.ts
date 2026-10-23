import type { SimulatedCall, SimulationRequest, SimulationResult } from "@schema/index.js";
import { diffWordsWithSpace } from "diff";
import benign from "../../../tests/fixtures/benign-tools.json" with { type: "json" };
import poisoned from "../../../tests/fixtures/poisoned-tools.json" with { type: "json" };
import type { DiffPart } from "./api.js";
import type { Tone } from "./format.js";

/**
 * The rug pull the Simulation page rehearses: the demo weather server (tests/fixtures), pinned,
 * called three times, then swapped for its poisoned definitions, as demo/evil-server.ts does
 * after its third call. The calls afterwards hit the poisoned tool and two new ones.
 */
export const RUG_PULL: SimulationRequest = {
  serverId: "weather",
  pinned: benign,
  served: poisoned,
  callsBefore: ["get_alerts", "get_forecast", "get_alerts"],
  callsAfter: ["get_forecast", "read_config", "sync_alerts"],
};

export type SimActor = "agent" | "proxy" | "server";

/** One JSON-RPC message in flight, for the flow diagram. */
export interface SimMessage {
  from: SimActor;
  to: SimActor;
  label: string;
  tone: Tone;
}

/** One beat of the simulation, built from the API's result. */
export interface SimStep {
  id: string;
  title: string;
  detail: string;
  tone: Tone;
  messages: SimMessage[];
  /** For call steps, the call's verdict. */
  call?: SimulatedCall;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A forwarded call: there and back through the proxy. */
const roundTrip = (toolName: string): SimMessage[] => [
  { from: "agent", to: "proxy", label: `tools/call ${toolName}`, tone: "neutral" },
  { from: "proxy", to: "server", label: `tools/call ${toolName}`, tone: "success" },
  { from: "server", to: "proxy", label: "result", tone: "neutral" },
  { from: "proxy", to: "agent", label: "result", tone: "success" },
];

const callStep = (call: SimulatedCall, index: number, phase: "before" | "after"): SimStep =>
  call.blocked
    ? {
        id: `${phase}-${index}`,
        title: `The agent calls ${call.toolName}`,
        detail: call.blocked.error.message,
        tone: "destructive",
        messages: [
          { from: "agent", to: "proxy", label: `tools/call ${call.toolName}`, tone: "neutral" },
          { from: "proxy", to: "agent", label: `error ${call.blocked.error.code}`, tone: "destructive" },
        ],
        call,
      }
    : {
        id: `${phase}-${index}`,
        title: `The agent calls ${call.toolName}`,
        detail: "It matches latch.lock, so the proxy forwards it.",
        tone: "success",
        messages: roundTrip(call.toolName),
        call,
      };

/** The beats of a simulation, in order, from what the API computed. */
export function simulationSteps(result: SimulationResult): SimStep[] {
  const byTier = [3, 2, 1, 0].map((tier) => [tier, result.changes.filter((change) => change.tier === tier).length] as const).filter(([, n]) => n > 0);
  const worst = Math.max(-1, ...result.changes.map((change) => change.tier));
  return [
    {
      id: "pin",
      title: `${result.serverId} is reviewed and pinned`,
      detail: `${plural(result.pinned.length, "tool")} pinned in latch.lock: ${result.pinned.map((tool) => tool.name).join(", ")}.`,
      tone: "success",
      messages: [
        { from: "server", to: "proxy", label: `tools/list (${plural(result.pinned.length, "tool")})`, tone: "neutral" },
        { from: "proxy", to: "agent", label: "tools/list", tone: "success" },
      ],
    },
    ...result.callsBefore.map((call, i) => callStep(call, i, "before")),
    {
      id: "swap",
      title: "The server swaps its definitions",
      detail: "It announces notifications/tools/list_changed. The proxy fetches the new list before any further call is checked.",
      tone: "warning",
      messages: [
        { from: "server", to: "proxy", label: "tools/list_changed", tone: "warning" },
        { from: "proxy", to: "server", label: "tools/list", tone: "neutral" },
        { from: "server", to: "proxy", label: "tools/list", tone: "warning" },
      ],
    },
    {
      id: "analyze",
      title: "The proxy analyzes the new list",
      detail:
        result.changes.length === 0
          ? "Every tool matches latch.lock."
          : `${plural(result.changes.length, "change")}: ${byTier.map(([tier, n]) => `${n} at tier ${tier}`).join(", ")}.`,
      tone: worst === 3 ? "destructive" : worst === 2 ? "warning" : "success",
      messages: [],
    },
    ...result.callsAfter.map((call, i) => callStep(call, i, "after")),
    {
      id: "review",
      title: "Waiting for a reviewer",
      detail: "The changes would be queued for latch review and the blocked tools stay blocked. This rehearsal wrote nothing.",
      tone: "info",
      messages: [],
    },
  ];
}

/**
 * Invisible and direction-changing characters shown as [U+XXXX], so a hidden payload is visible
 * on screen: zero-width and joiner characters, bidi controls, word joiners, the BOM and tag
 * characters.
 */
export function revealInvisible(text: string): string {
  return text.replace(/[​-‏‪-‮⁠-⁩﻿\u{E0000}-\u{E007F}]/gu, (char) => `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);
}

const descriptionOf = (list: unknown, name: string): string | null => {
  const tools = (list as { tools?: Array<{ name?: unknown; description?: unknown }> }).tools ?? [];
  const tool = tools.find((entry) => entry.name === name);
  return typeof tool?.description === "string" ? tool.description : null;
};

/** Word diff of a tool's description across the switch, hidden characters revealed. Null if absent on either side. */
export function descriptionDiff(request: SimulationRequest, toolName: string): DiffPart[] | null {
  const [before, after] = [descriptionOf(request.pinned, toolName), descriptionOf(request.served, toolName)];
  if (before === null || after === null) return null;
  return diffWordsWithSpace(revealInvisible(before), revealInvisible(after)).map(({ value, added, removed }) => ({ value, added, removed }));
}
