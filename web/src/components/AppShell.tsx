import type { ReactNode } from "react";
import { PixelLandscape, StarrySky } from "../art/PixelLandscape";
import { useData } from "../lib/data";
import { useTheme } from "../lib/theme";
import { sceneFor } from "../lib/themes";
import { href, type Page } from "../lib/router";
import { GitIcon, HomeIcon, LockIcon, LogIcon, QueueIcon, RefreshIcon, ServerIcon, SettingsIcon, ToolCheckIcon } from "./icons";
import { StatusDot, buttonClass } from "./ui";

export const NAV: Array<{ page: Exclude<Page, "not-found">; label: string; icon: ReactNode; href: string }> = [
  { page: "overview", label: "Overview", icon: <HomeIcon />, href: href({ page: "overview" }) },
  { page: "servers", label: "MCP Servers", icon: <ServerIcon />, href: href({ page: "servers" }) },
  { page: "review", label: "Review Queue", icon: <QueueIcon />, href: href({ page: "review", id: null }) },
  { page: "tools", label: "Approved Tools", icon: <ToolCheckIcon />, href: href({ page: "tools", server: null }) },
  { page: "audit", label: "Audit Log", icon: <LogIcon />, href: href({ page: "audit" }) },
  { page: "ci", label: "Git & CI", icon: <GitIcon />, href: href({ page: "ci" }) },
  { page: "settings", label: "Settings", icon: <SettingsIcon />, href: href({ page: "settings" }) },
];

const API_STATUS = {
  checking: { tone: "neutral", label: "Checking API", detail: "Contacting the review API" },
  connected: { tone: "success", label: "API connected", detail: "Reading latch.lock and .latch/ on this machine" },
  unreachable: { tone: "destructive", label: "API unreachable", detail: "Start it with pnpm ui or latch review --ui" },
} as const;

/** Count for the Review Queue nav item; destructive when a tier-3 change is waiting. */
function QueueCount() {
  const { pending } = useData();
  if (pending.status !== "ready" || pending.data.length === 0) return null;
  const highRisk = pending.data.some((item) => item.change.tier === 3);
  return (
    <span
      className={`ml-auto rounded-sm px-1.5 font-mono text-xs ${highRisk ? "bg-destructive text-destructive-foreground" : "bg-muted text-foreground"}`}
      aria-label={`${pending.data.length} pending`}
    >
      {pending.data.length}
    </span>
  );
}

function NavLinks({ current, layout }: { current: Page; layout: "sidebar" | "strip" }) {
  return (
    <ul className={layout === "sidebar" ? "space-y-1" : "flex gap-1"}>
      {NAV.map((item) => {
        const active = item.page === current;
        return (
          <li key={item.page}>
            <a
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active ? "bg-primary text-primary-foreground" : "text-sidebar-foreground hover:bg-muted"
              }`}
            >
              <span className={`text-base ${active ? "" : "text-muted-foreground"}`}>{item.icon}</span>
              {item.label}
              {item.page === "review" && <QueueCount />}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function AppShell({ current, children }: { current: Page; children: ReactNode }) {
  const { api, busy, reload } = useData();
  const { theme } = useTheme();
  const scene = sceneFor(theme);
  const status = API_STATUS[api];
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        // Focus instead of navigating: the hash is the router's (lib/router.ts).
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50">
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex h-14 items-center gap-3 px-4">
          <a href={href({ page: "overview" })} className="flex items-center gap-2 rounded-sm">
            <span className="text-xl text-accent">
              <LockIcon />
            </span>
            <span className="font-display text-lg font-bold tracking-tight">LatchVerify</span>
          </a>
          <span className="hidden border-l pl-3 font-mono text-xs uppercase tracking-widest text-muted-foreground sm:inline">MCP security proxy</span>
          <div className="ml-auto flex items-center gap-2">
            <span role="status" title={status.detail} className="flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs">
              <StatusDot tone={status.tone} />
              <span className="hidden sm:inline">{status.label}</span>
              <span className="sr-only sm:hidden">{status.label}</span>
            </span>
            <button type="button" onClick={reload} disabled={busy} className={buttonClass("secondary", "sm")} aria-label="Refresh data">
              <RefreshIcon className={busy ? "motion-safe:animate-spin" : undefined} />
              <span className="hidden sm:inline">{busy ? "Loading" : "Refresh"}</span>
            </button>
          </div>
        </div>
        <nav aria-label="Sections" className="overflow-x-auto border-t px-2 py-1.5 [scrollbar-width:none] md:hidden">
          <NavLinks current={current} layout="strip" />
        </nav>
      </header>

      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 border-r bg-sidebar md:block">
          <nav aria-label="Sections" className="sticky top-14 p-3">
            <NavLinks current={current} layout="sidebar" />
          </nav>
        </aside>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl space-y-6">{children}</div>
        </main>
      </div>
      {/*
        Backdrop behind the content column (the sidebar stays plain): the landscape at full width,
        its sky stretched up to the top as a gradient, starry at night. Fixed, so content scrolls
        over it.
      */}
      <div className="pointer-events-none fixed inset-0 top-14 -z-10 flex flex-col justify-end bg-gradient-to-b from-art-sky to-art-horizon md:left-56">
        {/* Stars thin out toward the top, where page headings sit on the sky without a card. */}
        {scene.time === "night" && <StarrySky className="block min-h-0 w-full flex-1 [mask-image:linear-gradient(to_bottom,transparent,black_75%)]" />}
        <PixelLandscape time={scene.time} extra={scene.extra} className="block h-auto min-h-40 w-full shrink-0" />
      </div>
    </div>
  );
}
