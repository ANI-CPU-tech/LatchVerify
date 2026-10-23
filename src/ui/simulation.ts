import { analyzeToolList } from "../proxy/analysis.js";
import { buildBlockError, shouldBlock } from "../proxy/blocker.js";
import type { LockFile, PendingChange, SimulatedCall, SimulationRequest, SimulationResult } from "../schema/index.js";
import { applyApproval, emptyLockfile } from "../store/lockfile.js";

/** approvedBy on the records a simulation pins. Nothing it pins is ever written to latch.lock. */
export const SIMULATION_REVIEWER = "simulation";

/** Protocol version a simulated server reports, as the demo servers do. */
const SIMULATED_SPEC_VERSION = "2025-06-18";

/** The simulation's input cannot be replayed: the API answers 400 with this message. */
export class SimulationInputError extends Error {}

/**
 * Rehearse a rug pull with the proxy's own code, entirely in memory: nothing is read from or
 * written to latch.lock, the review queue or the event log.
 *
 * 1. Every tool in `pinned` is analyzed and approved, as `latch init` would pin it.
 * 2. Each call in `callsBefore` gets the proxy's verdict against that lockfile.
 * 3. `served` is analyzed against the pins, as the proxy does after tools/list_changed; the
 *    changes it finds are what would be queued for review.
 * 4. Each call in `callsAfter` gets the verdict with those changes pending: a blocked call
 *    carries the exact JSON-RPC error the client would receive.
 */
export function simulateRugPull(request: SimulationRequest, now: Date): SimulationResult {
  const { serverId } = request;
  let lock: LockFile = emptyLockfile();
  lock.servers[serverId] = { transport: "stdio", command: SIMULATION_REVIEWER, args: [], tools: [] };

  const first = analyzeToolList(serverId, request.pinned, lock, SIMULATED_SPEC_VERSION, now);
  if (first === null) throw new SimulationInputError("pinned must be a tools/list result with a tools array");
  for (const { change } of first.changes) lock = applyApproval(lock, change, SIMULATION_REVIEWER, now);

  const replay = (names: string[], pending: PendingChange[], offset: number): SimulatedCall[] =>
    names.map((toolName, i) => {
      const verdict = shouldBlock(serverId, toolName, lock, pending);
      if (!verdict.blocked) return { toolName, blocked: null };
      const error = buildBlockError(offset + i, toolName, verdict.reason);
      return { toolName, blocked: { jsonrpc: "2.0", id: error.id, error: error.error! } };
    });

  const callsBefore = replay(request.callsBefore, [], 1);
  const second = analyzeToolList(serverId, request.served, lock, SIMULATED_SPEC_VERSION, now);
  if (second === null) throw new SimulationInputError("served must be a tools/list result with a tools array");
  const changes = second.changes.map(({ change }) => change);

  return {
    serverId,
    pinned: lock.servers[serverId]!.tools,
    callsBefore,
    changes,
    unchanged: second.unchanged,
    callsAfter: replay(request.callsAfter, changes, 1 + request.callsBefore.length),
  };
}
