import type { SimulationResult } from "@schema/index.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CapabilityDiff } from "../components/CapabilityDiff";
import { FindingList } from "../components/FindingList";
import { Select } from "../components/Select";
import { SimFlow } from "../components/SimFlow";
import { FlaskIcon, PauseIcon, PlayIcon, RefreshIcon, StepBackIcon, StepForwardIcon } from "../components/icons";
import { TextDiff } from "../components/TextDiff";
import { TierBadge } from "../components/TierBadge";
import { Badge, ErrorState, JsonView, LoadingState, PageHeader, Panel, StatusDot, buttonClass } from "../components/ui";
import { simulateRugPull } from "../lib/api";
import type { Tone } from "../lib/format";
import { RUG_PULL, descriptionDiff, playerKey, simulationSteps, type SimStep } from "../lib/simulation";

/** Milliseconds a step stays on screen at 1x. */
const STEP_MS = 2600;
const SPEEDS = [0.5, 1, 2] as const;
/** Half speed by default, so each step can be read as it plays. */
const DEFAULT_SPEED: (typeof SPEEDS)[number] = 0.5;

const TONE_RING: Record<Tone, string> = {
  neutral: "border-border",
  success: "border-success/60",
  warning: "border-warning/60",
  destructive: "border-destructive/60",
  info: "border-info/60",
};

type Run = { status: "loading" } | { status: "error"; error: unknown } | { status: "ready"; result: SimulationResult };

const prefersReducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** A rug pull rehearsed with the proxy's own analysis, in memory, played back step by step. */
export function Simulation() {
  const [run, setRun] = useState<Run>({ status: "loading" });
  const [index, setIndex] = useState(0);
  // Autoplay, unless the viewer asked for less motion; they can still press Play.
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(DEFAULT_SPEED);

  const start = useCallback((signal?: AbortSignal) => {
    setRun({ status: "loading" });
    setIndex(0);
    simulateRugPull(RUG_PULL, signal).then(
      (result) => setRun({ status: "ready", result }),
      (error: unknown) => {
        if (!signal?.aborted) setRun({ status: "error", error });
      },
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    start(controller.signal);
    return () => controller.abort();
  }, [start]);

  const steps = useMemo(() => (run.status === "ready" ? simulationSteps(run.result) : []), [run]);
  const last = steps.length - 1;

  useEffect(() => {
    if (!playing || steps.length === 0) return;
    if (index >= last) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex((i) => Math.min(i + 1, last)), STEP_MS / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, last, speed, steps.length]);

  // Keyboard: Space or K plays and pauses, the left and right arrows step. Only when nothing
  // interactive has focus, so links, buttons, the speed menu and the nav keep their own keys.
  useEffect(() => {
    if (steps.length === 0) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest("a, button, input, select, textarea, [contenteditable], [role=tab], [role=listbox]")) return;
      const action = playerKey(event.key);
      if (action === null) return;
      event.preventDefault();
      if (action === "previous") setIndex((i) => Math.max(0, i - 1));
      else if (action === "next") setIndex((i) => Math.min(last, i + 1));
      else {
        if (index >= last) setIndex(0);
        setPlaying((p) => !p || index >= last);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [steps.length, last, index]);

  const step = steps[index];
  const swapAt = steps.findIndex((entry) => entry.id === "swap");

  return (
    <>
      <PageHeader
        title="Simulation"
        description="Rehearse a rug pull with the proxy's own analysis. It runs in memory: nothing is written to latch.lock, the review queue or the audit log."
        actions={
          <button type="button" onClick={() => start()} className={buttonClass("secondary", "sm")} disabled={run.status === "loading"}>
            <RefreshIcon />
            Run again
          </button>
        }
      />

      {run.status === "loading" && (
        <Panel>
          <LoadingState label="Running the simulation..." />
        </Panel>
      )}
      {run.status === "error" && (
        <Panel>
          <ErrorState
            title="The simulation runs through the review API. Start it with pnpm ui or latch review --ui."
            error={run.error}
            onRetry={() => start()}
          />
        </Panel>
      )}

      {run.status === "ready" && step && (
        <>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Playback">
            <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} className={buttonClass("secondary", "sm")} aria-label="Previous step">
              <StepBackIcon />
            </button>
            <button
              type="button"
              onClick={() => {
                if (index >= last) setIndex(0);
                setPlaying((p) => !p || index >= last);
              }}
              // Fixed width: "Pause", "Play" and "Replay" differ, and the controls beside it must not shift.
              className={`${buttonClass("primary", "sm")} w-24`}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
              {playing ? "Pause" : index >= last ? "Replay" : "Play"}
            </button>
            <button type="button" onClick={() => setIndex((i) => Math.min(last, i + 1))} disabled={index === last} className={buttonClass("secondary", "sm")} aria-label="Next step">
              <StepForwardIcon />
            </button>
            <label htmlFor="sim-speed" className="ml-2 text-xs text-muted-foreground">
              Speed
            </label>
            <Select
              id="sim-speed"
              size="sm"
              value={String(speed)}
              options={SPEEDS.map((value) => ({ value: String(value), label: `${value}x` }))}
              onChange={(value) => setSpeed(Number(value) as (typeof SPEEDS)[number])}
            />
            <span className="ml-auto flex items-center gap-3 font-mono text-xs text-muted-foreground">
              <span className="hidden lg:inline">Space play/pause · ← → step</span>
              <span>
                Step {index + 1} of {steps.length}
              </span>
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
          </div>

          <Panel>
            <SimFlow step={step} swapped={swapAt >= 0 && index >= swapAt} speed={speed} paused={!playing && index < last} />
          </Panel>

          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Panel title="Timeline" icon={<FlaskIcon />} bodyClassName="p-2">
              <ol className="space-y-1">
                {steps.map((entry, i) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setIndex(i);
                        setPlaying(false);
                      }}
                      aria-current={i === index ? "step" : undefined}
                      className={`flex w-full items-start gap-2 rounded-md border-l-4 px-3 py-2 text-left text-sm transition-colors ${
                        i === index
                          ? `bg-muted font-medium ${TONE_RING[entry.tone]}`
                          : `border-transparent ${i < index ? "text-foreground hover:bg-muted/60" : "text-muted-foreground hover:bg-muted/60"}`
                      }`}
                    >
                      <span className="mt-1.5">
                        <StatusDot tone={i <= index ? entry.tone : "neutral"} />
                      </span>
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ol>
            </Panel>

            <Panel title="What happens">
              <div key={step.id} className="space-y-4 motion-safe:animate-[sim-enter_0.4s_ease-out]" aria-live="polite">
                <StepDetail step={step} result={run.result} />
              </div>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

function StepDetail({ step, result }: { step: SimStep; result: SimulationResult }) {
  return (
    <>
      <div className={`rounded-md border-l-4 pl-3 ${TONE_RING[step.tone]}`}>
        <h2 className="font-display text-lg font-bold">{step.title}</h2>
        <p className="text-sm text-muted-foreground">{step.detail}</p>
      </div>

      {step.id === "pin" && (
        <ul className="flex flex-wrap gap-2">
          {result.pinned.map((tool) => (
            <li key={tool.name}>
              <Badge tone="success" className="font-mono">
                {tool.name}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {step.call?.blocked && <JsonView value={step.call.blocked} label={`JSON-RPC error returned for ${step.call.toolName}`} />}

      {step.id === "analyze" && (
        <ul className="space-y-4">
          {result.changes.map((change) => {
            const diff = descriptionDiff(RUG_PULL, change.toolName);
            return (
              <li key={change.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{change.toolName}</span>
                  <TierBadge tier={change.tier} />
                  {change.before === null && <Badge tone="info">new tool</Badge>}
                </div>
                <CapabilityDiff before={change.before?.capabilities ?? null} after={change.after.capabilities} />
                {diff && <TextDiff parts={diff} />}
                {change.findings.length > 0 && <FindingList findings={change.findings} />}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
