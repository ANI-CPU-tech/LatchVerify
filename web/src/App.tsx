import { Suspense, lazy, useEffect, type ReactNode } from "react";
import { AppShell, NAV } from "./components/AppShell";
import { PageTransition } from "./components/PageTransition";
import { EmptyState, LoadingState, Panel, buttonClass } from "./components/ui";
import { DataProvider, useData } from "./lib/data";
import { href, type Route } from "./lib/router";
import { navigate, useRoute } from "./lib/useRoute";
import { ThemeProvider } from "./lib/theme";
import { Audit } from "./pages/Audit";
import { GitCi } from "./pages/GitCi";
import { Overview } from "./pages/Overview";
import { Review } from "./pages/Review";
import { Servers } from "./pages/Servers";
import { Settings } from "./pages/Settings";
import { Tools } from "./pages/Tools";

/**
 * Demo material, development mode only. Loaded on first visit, so its code (and the test fixtures
 * it rehearses with) is a separate chunk that a real install never downloads.
 */
const Simulation = lazy(() => import("./pages/Simulation").then((module) => ({ default: module.Simulation })));

function NotFound({ path }: { path: string }) {
  return (
    <Panel>
      <EmptyState title="Page not found">
        <p>
          Nothing lives at <code className="font-mono">{path}</code>.
        </p>
        <a href={href({ page: "overview" })} className={`${buttonClass("secondary", "sm")} mt-3`}>
          Go to Overview
        </a>
      </EmptyState>
    </Panel>
  );
}

const DevTools = lazy(() => import("./pages/DevTools").then((module) => ({ default: module.DevTools })));

/**
 * A development-mode page (Simulation, Dev Tools) when the API says development mode is on. In
 * normal mode it leaves no trace: a link to it goes to Overview, replacing the history entry.
 */
function DevOnly({ loading, children }: { loading: string; children: ReactNode }) {
  const { info, dev } = useData();
  const hidden = info.status !== "loading" && !dev;
  useEffect(() => {
    if (hidden) navigate({ page: "overview" }, { replace: true });
  }, [hidden]);
  if (!dev) return info.status === "loading" ? <LoadingState label="Loading..." /> : null;
  return <Suspense fallback={<LoadingState label={loading} />}>{children}</Suspense>;
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case "overview":
      return <Overview />;
    case "servers":
      return <Servers />;
    case "review":
      return <Review selectedId={route.id} />;
    case "tools":
      return <Tools server={route.server} />;
    case "audit":
      return <Audit />;
    case "ci":
      return <GitCi />;
    case "simulation":
      return (
        <DevOnly loading="Loading the simulation...">
          <Simulation />
        </DevOnly>
      );
    case "devtools":
      return (
        <DevOnly loading="Loading the dev tools...">
          <DevTools />
        </DevOnly>
      );
    case "settings":
      return <Settings />;
    case "not-found":
      return <NotFound path={route.path} />;
  }
}

/** The page for the current route, titled after its nav entry; a hidden dev-only page is "Not found". */
function Routed() {
  const route = useRoute();
  const { dev } = useData();
  const label = NAV.find((item) => item.page === route.page && (dev || !item.devOnly))?.label ?? "Not found";

  useEffect(() => {
    document.title = `${label} · LatchVerify`;
  }, [label]);

  return (
    <AppShell current={route.page}>
      <PageTransition pageKey={route.page}>
        <Page route={route} />
      </PageTransition>
    </AppShell>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <DataProvider>
        <Routed />
      </DataProvider>
    </ThemeProvider>
  );
}
