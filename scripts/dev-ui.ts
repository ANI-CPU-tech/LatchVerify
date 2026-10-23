import { main } from "../src/ui/server.js";
import { mountBuildRoutes } from "./package/routes.js";

// `pnpm ui`: the review API plus the development-only build API (/api/build/*) for the
// Build & Distribution page. `latch review --ui` serves the review API alone.
main((app) => mountBuildRoutes(app)).catch((error: unknown) => {
  console.error(`[latch ui] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
