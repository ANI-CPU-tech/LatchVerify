/**
 * Hash routes: #/, #/servers, #/review/<change id>, #/tools/<server id>, #/simulation, ... Hash routing works
 * the same under the Vite dev server and the built UI that `latch review --ui` serves.
 */
export type Route =
  | { page: "overview" }
  | { page: "servers" }
  | { page: "review"; id: string | null }
  | { page: "tools"; server: string | null }
  | { page: "audit" }
  | { page: "ci" }
  | { page: "simulation" }
  | { page: "settings" }
  | { page: "not-found"; path: string };

export type Page = Route["page"];

const SEGMENTS: Record<string, Page> = {
  "": "overview",
  servers: "servers",
  review: "review",
  tools: "tools",
  audit: "audit",
  "git-ci": "ci",
  simulation: "simulation",
  settings: "settings",
};

const decode = (part: string | undefined): string | null => {
  if (part === undefined || part === "") return null;
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/** Parses location.hash. Unknown paths are a not-found route, never a crash. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+/, "");
  const [head = "", param, ...rest] = path.split("/");
  const page = SEGMENTS[head];
  if (page === undefined || rest.length > 0) return { page: "not-found", path: `/${path}` };
  if (page === "review") return { page, id: decode(param) };
  if (page === "tools") return { page, server: decode(param) };
  if (param !== undefined && param !== "") return { page: "not-found", path: `/${path}` };
  return { page } as Route;
}

/** The href for a route. */
export function href(route: Exclude<Route, { page: "not-found" }>): string {
  const head = Object.keys(SEGMENTS).find((key) => SEGMENTS[key] === route.page)!;
  const param = route.page === "review" ? route.id : route.page === "tools" ? route.server : null;
  return `#/${head}${param ? `/${encodeURIComponent(param)}` : ""}`;
}
