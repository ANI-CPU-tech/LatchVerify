import { useEffect, useState } from "react";
import { href, parseRoute, type Route } from "./router";

/** The current route, following hashchange. Browser-only; the parsing lives in router.ts. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const navigate = (route: Exclude<Route, { page: "not-found" }>): void => {
  window.location.hash = href(route);
};
