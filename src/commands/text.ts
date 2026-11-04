import { formatCodepoint } from "../analyze/unicode.js";
import type { ClientConfig, ConfigProblem } from "../config/clients.js";

/**
 * Text safe to print on a terminal: control and format characters (escape sequences, bidi
 * overrides, zero-width characters, line separators) become [U+XXXX]. Other Unicode is kept.
 * Use it for every string a server or a file controls.
 */
export function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `[${formatCodepoint(char.codePointAt(0)!)}]`);
}

/** A config's file for people, with the part of it when that is not the whole file: "~/.claude.json (project /app)". */
export function configPlace(config: Pick<ClientConfig, "path" | "scope">): string {
  return printable(config.scope === undefined ? config.path : `${config.path} (${config.scope})`);
}

/** The warning for a client config that exists but cannot be used (see detectClients). */
export function problemWarning(problem: ConfigProblem): string {
  return `! ${problem.client}: ${printable(problem.path)} ${printable(problem.message)}; LatchVerify leaves it unchanged`;
}

/**
 * The warning about backups earlier versions left (findOldBackups): whole copies of client
 * configs, keys included, that only the user should delete.
 */
export function oldBackupWarning(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  return [
    `! ${paths.length === 1 ? "1 copy" : `${paths.length} copies`} of your client configs, made by an earlier LatchVerify version, still ${paths.length === 1 ? "holds" : "hold"} your API keys. LatchVerify no longer makes them; delete ${paths.length === 1 ? "it" : "them"}:`,
    ...paths.map((path) => `    ${printable(path)}`),
  ];
}

/** "1 tool", "2 tools"; pass `many` for irregular plurals ("entries"). */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}
