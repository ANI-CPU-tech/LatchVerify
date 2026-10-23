import type { CSSProperties, ReactNode } from "react";
import type { Tone } from "../lib/format";
import type { SimActor, SimStep } from "../lib/simulation";
import { BlockIcon, LockIcon, ServerIcon, TerminalIcon } from "./icons";

/** Horizontal position of each actor across the diagram. */
const X: Record<SimActor, number> = { agent: 10, proxy: 50, server: 90 };

const PACKET: Record<Tone, string> = {
  neutral: "border-border bg-card text-foreground",
  success: "border-success/50 bg-success/15 text-success",
  warning: "border-warning/50 bg-warning/15 text-warning",
  destructive: "border-destructive/50 bg-destructive/15 text-destructive",
  info: "border-info/50 bg-info/15 text-info",
};

/** Seconds each message takes to cross at 1x. */
const HOP_S = 0.9;

function Node({ x, icon, label, sub, alert }: { x: number; icon: ReactNode; label: string; sub: string; alert: boolean }) {
  return (
    <div className="absolute bottom-0 flex w-28 -translate-x-1/2 flex-col items-center text-center" style={{ left: `${x}%` }}>
      <span
        className={`flex h-11 w-11 items-center justify-center rounded-full border-2 bg-card-glass text-xl ${
          alert ? "border-destructive text-destructive motion-safe:animate-pulse" : "border-primary/60 text-primary"
        }`}
      >
        {icon}
      </span>
      <span className="mt-1 text-xs font-medium">{label}</span>
      <span className={`text-[11px] ${alert ? "text-destructive" : "text-muted-foreground"}`}>{sub}</span>
    </div>
  );
}

/**
 * Agent, proxy and server, with the step's JSON-RPC messages crossing between them one after
 * another. Without motion the messages are shown where they arrive. A list repeats them for
 * screen readers.
 */
export function SimFlow({ step, swapped, speed }: { step: SimStep; swapped: boolean; speed: number }) {
  const blocking = step.messages.some((message) => message.from === "proxy" && message.tone === "destructive");
  return (
    <figure className="space-y-2">
      <div className="relative h-48 overflow-hidden" aria-hidden="true">
        <div className="absolute bottom-[3.6rem] left-[10%] right-[10%] border-t-2 border-dashed border-border" />
        {step.messages.map((message, i) => {
          const style = {
            "--from": `${X[message.from]}%`,
            "--to": `${X[message.to]}%`,
            left: `${X[message.to]}%`,
            top: `${i * 1.6}rem`,
            animationDuration: `${HOP_S / speed}s`,
            animationDelay: `${(i * HOP_S) / speed}s`,
          } as CSSProperties;
          return (
            <span
              key={`${step.id}-${i}`}
              style={style}
              className={`absolute -translate-x-1/2 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px] shadow-card motion-safe:animate-[sim-travel_ease-in-out_both] ${PACKET[message.tone]}`}
            >
              {message.from === "proxy" && message.tone === "destructive" && <BlockIcon className="mr-1 inline align-[-2px]" />}
              {message.label}
            </span>
          );
        })}
        <Node x={X.agent} icon={<TerminalIcon />} label="AI agent" sub="MCP client" alert={false} />
        <Node x={X.proxy} icon={<LockIcon />} label="LatchVerify" sub={blocking ? "blocking" : "checking"} alert={blocking} />
        <Node x={X.server} icon={<ServerIcon />} label="MCP server" sub={swapped ? "definitions swapped" : "as pinned"} alert={swapped} />
      </div>
      <figcaption className="sr-only">
        {step.messages.length === 0 ? (
          "No messages in this step."
        ) : (
          <ol>
            {step.messages.map((message, i) => (
              <li key={i}>
                {message.from} to {message.to}: {message.label}
              </li>
            ))}
          </ol>
        )}
      </figcaption>
    </figure>
  );
}
