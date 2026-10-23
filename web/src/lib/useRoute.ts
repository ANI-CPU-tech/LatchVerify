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

/**
 * Goes to `route`. With `replace`, the current history entry is replaced instead of a new one
 * pushed, for moves that should not each become a Back step (stepping through a list by key).
 */
export const navigate = (route: Exclude<Route, { page: "not-found" }>, { replace = false }: { replace?: boolean } = {}): void => {
  if (replace) window.location.replace(href(route));
  else window.location.hash = href(route);
};
