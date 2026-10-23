import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Tone } from "../lib/format";
import { describeError } from "../lib/data";
import { AlertIcon, ArrowRightIcon, RefreshIcon } from "./icons";

/** Shared building blocks. Colors come only from theme tokens (src/index.css). */

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
};

const TONE_BADGE: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
};

export function Badge({ tone = "neutral", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-xs font-medium ${TONE_BADGE[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />;
}

const BUTTON = {
  primary: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "border-input bg-card text-foreground hover:bg-muted",
  danger: "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90",
  ghost: "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
} as const;

/**
 * Buttons ease their colors, lift a pixel with a soft shadow on hover and give a little on press;
 * disabled ones stay put. Movement only for viewers who have not asked for reduced motion.
 */
export const buttonClass = (variant: keyof typeof BUTTON = "secondary", size: "sm" | "md" = "md"): string =>
  `inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out hover:shadow-card motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none ${
    size === "sm" ? "px-2.5 py-1 text-xs" : "px-4 py-2 text-sm"
  } ${BUTTON[variant]}`;

export const inputClass =
  "rounded-md border border-input bg-card px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled surface. Pages use one level of these; never nest them. */
export function Panel({
  title,
  icon,
  action,
  children,
  className = "",
  bodyClassName = "p-4",
}: {
  title?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`min-w-0 rounded-lg border bg-card-glass backdrop-blur-sm text-card-foreground shadow-card ${className}`}>
      {title && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <h2 className="flex min-w-0 items-center gap-2 font-display text-sm font-bold">
            {icon && <span className="text-accent">{icon}</span>}
            {title}
          </h2>
          {action}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** "View all →" style link for panel headers. */
export function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="group inline-flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium text-primary hover:underline">
      {children}
      <span className="transition-transform duration-200 motion-safe:group-hover:translate-x-0.5">
        <ArrowRightIcon />
      </span>
    </a>
  );
}

/** Dark panel for commands, JSON and other raw text. */
export function Terminal({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="max-h-[28rem] overflow-auto rounded-md bg-terminal p-4 font-mono text-xs leading-relaxed text-terminal-foreground"
    >
      {children}
    </pre>
  );
}

/** JSON in a terminal panel, keys highlighted. Text only: values are never rendered as HTML. */
export function JsonView({ value, label }: { value: unknown; label?: string }) {
  const text = JSON.stringify(value, null, 2);
  const parts = text.split(/("(?:[^"\\]|\\.)*")(\s*:)/g);
  return (
    <Terminal label={label}>
      {parts.map((part, i) =>
        i % 3 === 1 ? (
          <span key={i} className="text-terminal-accent">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </Terminal>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
      <RefreshIcon aria-hidden="true" className="text-primary motion-safe:animate-spin" />
      {label}
    </p>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="status" className="px-4 py-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function ErrorState({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertIcon />
        {title}
      </p>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{describeError(error)}</pre>
      {onRetry && (
        <button type="button" onClick={onRetry} className={buttonClass("secondary", "sm")}>
          Try again
        </button>
      )}
    </div>
  );
}

export interface TabSpec {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

/** WAI-ARIA tabs: arrow keys, Home and End move between tabs. */
export function Tabs({ tabs, label }: { tabs: TabSpec[]; label: string }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const list = useRef<HTMLDivElement>(null);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  const selectedIndex = tabs.findIndex((tab) => tab.id === current?.id);
  // One underline that slides to the selected tab, measured from the DOM.
  const [underline, setUnderline] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const root = list.current;
    if (!root) return;
    const measure = () => {
      const tab = refs.current[selectedIndex];
      setUnderline(tab ? { left: tab.offsetLeft, width: tab.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const tab of refs.current) if (tab) observer.observe(tab);
    return () => observer.disconnect();
  }, [selectedIndex, tabs.length]);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    setActive(tabs[next]!.id);
    refs.current[next]?.focus();
  };

  return (
    <div>
      <div ref={list} role="tablist" aria-label={label} className="relative flex gap-1 overflow-x-auto border-b [scrollbar-width:none]">
        {underline && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-primary transition-[transform,width] duration-300 ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(${underline.left}px)`, width: underline.width }}
          />
        )}
        {tabs.map((tab, i) => {
          const selected = tab.id === current?.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(event) => onKeyDown(event, i)}
              className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                selected ? `text-primary ${underline ? "border-transparent" : "border-primary"}` : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {current && (
        <div
          key={current.id}
          role="tabpanel"
          id={`${base}-panel-${current.id}`}
          aria-labelledby={`${base}-tab-${current.id}`}
          tabIndex={0}
          className="pt-4 motion-safe:animate-[ui-fade_0.25s_ease-out]"
        >
          {current.content}
        </div>
      )}
    </div>
  );
}
