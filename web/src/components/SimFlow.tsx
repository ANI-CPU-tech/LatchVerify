import type { CSSProperties, ReactNode } from "react";
import type { Tone } from "../lib/format";
import type { SimActor, SimStep } from "../lib/simulation";
import { BlockIcon, LockIcon, ServerIcon, TerminalIcon } from "./icons";

/**
 * Horizontal position of each actor across the diagram, inset far enough that a node and its
 * label (w-24) fit inside the box on a phone.
 */
const X: Record<SimActor, number> = { agent: 14, proxy: 50, server: 86 };

const PACKET: Record<Tone, string> = {
  neutral: "border-border bg-card text-foreground",
  success: "border-success/50 bg-success/15 text-success",
  warning: "border-warning/50 bg-warning/15 text-warning",
  destructive: "border-destructive/50 bg-destructive/15 text-destructive",
  info: "border-info/50 bg-info/15 text-info",
};

/** Line and dot color for each outcome; neutral messages use the primary color to stay visible. */
const TRACK: Record<Tone, string> = {
  neutral: "text-primary",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
};

/** Seconds each message takes to cross at 1x. */
const HOP_S = 0.9;

/** Dots in each message's stream along the line, and the gap between them in seconds. */
const DOTS = [0, 1, 2] as const;
const DOT_GAP_S = 0.12;

function Node({ x, icon, label, sub, alert, scanning = false }: { x: number; icon: ReactNode; label: string; sub: string; alert: boolean; scanning?: boolean }) {
  return (
    <div className="absolute bottom-0 flex w-24 -translate-x-1/2 flex-col items-center text-center" style={{ left: `${x}%` }}>
      <span
        className={`relative flex h-11 w-11 items-center justify-center rounded-full border-2 bg-card-glass text-xl ${
          alert ? "border-destructive text-destructive motion-safe:animate-pulse" : "border-primary/60 text-primary"
        }`}
      >
        {scanning && <span className="absolute inset-0 hidden rounded-full border-2 border-primary motion-safe:block motion-safe:animate-ping" />}
        {icon}
      </span>
      <span className="mt-1 text-xs font-medium">{label}</span>
      <span className={`text-[11px] ${alert ? "text-destructive" : "text-muted-foreground"}`}>{sub}</span>
    </div>
  );
}

/**
 * Agent, proxy and server, with the step's JSON-RPC messages crossing between them one after
 * another: the label moves above, and on the dotted line the stretch it crosses lights up with
 * dashes marching its way while a stream of dots runs along it. The proxy shows a scanning ring
 * while it analyzes. Without motion the labels are shown where they arrive and the line stays
 * still. A list repeats the messages for screen readers.
 */
export function SimFlow({ step, swapped, speed }: { step: SimStep; swapped: boolean; speed: number }) {
  const blocking = step.messages.some((message) => message.from === "proxy" && message.tone === "destructive");
  return (
    <figure className="space-y-2">
      <div className="relative h-48 overflow-hidden" aria-hidden="true">
        <div className="absolute bottom-[3.6rem] border-t-2 border-dashed border-border" style={{ left: `${X.agent}%`, right: `${100 - X.server}%` }} />
        {step.messages.map((message, i) => {
          const [from, to] = [X[message.from], X[message.to]];
          const delay = (i * HOP_S) / speed;
          const hop = HOP_S / speed;
          return (
            <div key={`${step.id}-track-${i}`} className={`hidden motion-safe:block ${TRACK[message.tone]}`}>
              {/* The stretch of line this message crosses, dashes marching toward the receiver. */}
              <span
                className="absolute bottom-[3.6rem] h-0.5 opacity-0"
                style={
                  {
                    left: `${Math.min(from, to)}%`,
                    width: `${Math.abs(to - from)}%`,
                    backgroundImage: "repeating-linear-gradient(90deg, currentColor 0 6px, transparent 6px 12px)",
                    "--march": to > from ? "12px" : "-12px",
                    animation: `sim-march 0.45s linear infinite, sim-window ${hop}s linear ${delay}s both`,
                  } as CSSProperties
                }
              />
              {DOTS.map((k) => (
                <span
                  key={k}
                  className="absolute bottom-[calc(3.6rem_-_3px)] -translate-x-1/2 rounded-full bg-current opacity-0 shadow-[0_0_8px_currentColor]"
                  style={
                    {
                      "--from": `${from}%`,
                      "--to": `${to}%`,
                      left: `${to}%`,
                      width: `${8 - k * 2}px`,
                      height: `${8 - k * 2}px`,
                      animation: `sim-dot ${hop}s ease-in-out ${delay + (k * DOT_GAP_S) / speed}s both`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
          );
        })}
        {step.messages.map((message, i) => {
          const style = {
            "--from": `${X[message.from]}%`,
            "--to": `${X[message.to]}%`,
            left: `${X[message.to]}%`,
            // Anchored by its own position (14% of its width at 14%, half at the middle), so a
            // label near either end stays inside the box; sim-travel moves this with it.
            transform: `translateX(-${X[message.to]}%)`,
            top: `${i * 1.6}rem`,
            animationDuration: `${HOP_S / speed}s`,
            animationDelay: `${(i * HOP_S) / speed}s`,
          } as CSSProperties;
          return (
            <span
              key={`${step.id}-${i}`}
              style={style}
              className={`absolute whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[11px] shadow-card motion-safe:animate-[sim-travel_ease-in-out_both] ${PACKET[message.tone]}`}
            >
              {message.from === "proxy" && message.tone === "destructive" && <BlockIcon className="mr-1 inline align-[-2px]" />}
              {message.label}
            </span>
          );
        })}
        <Node x={X.agent} icon={<TerminalIcon />} label="AI agent" sub="MCP client" alert={false} />
        <Node
          x={X.proxy}
          icon={<LockIcon />}
          label="LatchVerify"
          sub={blocking ? "blocking" : step.id === "analyze" ? "analyzing" : "checking"}
          alert={blocking}
          scanning={step.id === "analyze"}
        />
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
