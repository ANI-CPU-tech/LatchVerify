import type { RouteDeps } from "./routes.js";

export interface UiServerOptions extends RouteDeps {
  port: number;
  /** Directory of the built web/ bundle to serve as static files; omitted in dev (Vite serves it). */
  staticDir?: string;
}

export interface UiServerHandle {
  url: string;
  close(): Promise<void>;
}

/**
 * TODO: build createRoutes(options), mount serveStatic for options.staticDir with an index.html
 * fallback, bind @hono/node-server to 127.0.0.1:options.port (never 0.0.0.0: the API can approve
 * changes), and resolve with the URL and a close handle.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  throw new Error("not implemented");
}

// `pnpm ui` runs this file directly; Vite proxies /api here.
if (import.meta.url === `file://${process.argv[1]}`) {
  startUiServer({
    port: Number(process.env.LATCH_UI_PORT ?? 7777),
    lockfilePath: process.env.LATCH_LOCKFILE_PATH ?? "./latch.lock",
    stateDir: process.env.LATCH_STATE_DIR ?? "./.latch",
    reviewer: "local",
  }).catch((error: unknown) => {
    console.error(`[latch ui] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
