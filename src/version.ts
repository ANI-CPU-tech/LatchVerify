import { readFileSync } from "node:fs";

/** This install's version: package.json sits one level above both src/version.ts and dist/version.js. */
export const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
