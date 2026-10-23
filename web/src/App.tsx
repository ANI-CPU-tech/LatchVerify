import { useEffect } from "react";
import { AppShell, NAV } from "./components/AppShell";
import { PageTransition } from "./components/PageTransition";
import { EmptyState, Panel, buttonClass } from "./components/ui";
import { DataProvider } from "./lib/data";
import { href, type Route } from "./lib/router";
import { useRoute } from "./lib/useRoute";
import { ThemeProvider } from "./lib/theme";
import { Audit } from "./pages/Audit";
import { GitCi } from "./pages/GitCi";
import { Overview } from "./pages/Overview";
import { Review } from "./pages/Review";
import { Servers } from "./pages/Servers";
import { Settings } from "./pages/Settings";
import { Simulation } from "./pages/Simulation";
import { Tools } from "./pages/Tools";

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
      return <Simulation />;
    case "settings":
      return <Settings />;
    case "not-found":
      return (
        <Panel>
          <EmptyState title="Page not found">
            <p>
              Nothing lives at <code className="font-mono">{route.path}</code>.
            </p>
            <a href={href({ page: "overview" })} className={`${buttonClass("secondary", "sm")} mt-3`}>
              Go to Overview
            </a>
          </EmptyState>
        </Panel>
      );
  }
}

export function App() {
  const route = useRoute();
  const label = NAV.find((item) => item.page === route.page)?.label ?? "Not found";

  useEffect(() => {
    document.title = `${label} · LatchVerify`;
  }, [label]);

  return (
    <ThemeProvider>
      <DataProvider>
        <AppShell current={route.page}>
          <PageTransition pageKey={route.page}>
            <Page route={route} />
          </PageTransition>
        </AppShell>
      </DataProvider>
    </ThemeProvider>
  );
}
