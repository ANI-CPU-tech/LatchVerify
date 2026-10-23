import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAdaptorServer } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createRoutes, type RouteDeps } from "./routes.js";

/** The only interface the review server listens on: the API can approve changes. */
export const UI_HOST = "127.0.0.1";

export interface UiServerOptions extends RouteDeps {
  /** TCP port; 0 picks a free one (see UiServerHandle.url). */
  port: number;
  /** Directory of the built web/ bundle to serve as static files; omitted in dev (Vite serves it). */
  staticDir?: string;
}

export interface UiServerHandle {
  /** Base URL the server is reachable on, with the actual port. */
  url: string;
  /** Stops accepting connections and closes open ones. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Starts the review server on 127.0.0.1 (never 0.0.0.0). With `staticDir`, it also serves the
 * built review UI, answering unknown non-API paths with index.html so client-side routes load.
 * Resolves once the port is bound; rejects if it cannot be (for example, EADDRINUSE) or if
 * `staticDir` has no index.html.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new RangeError(`startUiServer: port must be an integer from 0 to 65535, got ${options.port}`);
  }
  const app = createRoutes(options);

  if (options.staticDir !== undefined) {
    const root = resolve(options.staticDir);
    let indexHtml: string;
    try {
      indexHtml = await readFile(join(root, "index.html"), "utf8");
    } catch (error) {
      throw new Error(`startUiServer: ${root} has no index.html; build the UI with \`vite build\` first`, { cause: error });
    }
    app.use("*", serveStatic({ root }));
    app.get("*", (c) => (c.req.path === "/api" || c.req.path.startsWith("/api/") ? c.notFound() : c.html(indexHtml)));
  }

  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, UI_HOST, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${UI_HOST}:${port}`,
    close: () =>
      (closing ??= new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        // Keep-alive connections would otherwise hold close() open.
        if ("closeAllConnections" in server) server.closeAllConnections();
      })),
  };
}

/** `git config user.email` in the current directory, or undefined when git or the setting is missing. */
function gitUserEmail(): string | undefined {
  try {
    const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 });
    return email.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Who approvals are recorded as: LATCH_REVIEWER, else the git user.email, else the OS user name. */
export function defaultReviewer(env: NodeJS.ProcessEnv = process.env): string {
  return env.LATCH_REVIEWER?.trim() || gitUserEmail() || userInfo().username;
}

// `pnpm ui` runs this file directly; Vite proxies /api here.
// shortcut: reads three env vars itself because config/env.ts loadEnv is not implemented yet;
// switch to loadEnv() once it lands.
async function main(): Promise<void> {
  const reviewer = defaultReviewer();
  const handle = await startUiServer({
    port: Number(process.env.LATCH_UI_PORT || "7777"),
    lockfilePath: process.env.LATCH_LOCKFILE_PATH || "./latch.lock",
    stateDir: process.env.LATCH_STATE_DIR || "./.latch",
    reviewer,
  });
  console.error(`[latch ui] review API on ${handle.url} (approvals recorded as ${reviewer})`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void handle.close().finally(() => process.exit(0)));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(`[latch ui] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
