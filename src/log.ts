import { LOG_LEVELS, type LogLevel } from "./config/env.js";

/** Leveled diagnostics for stderr. stdout is the protocol in proxy mode, so nothing goes there. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * A Logger that writes every message at or above `level` (LATCH_LOG_LEVEL) as one line:
 * `[latch] message` for info, and `[latch] debug: `, `[latch] warning: ` or `[latch] error: `
 * before the message for the other levels.
 */
export function createLogger(level: LogLevel = "info", write: (line: string) => void = (line) => void process.stderr.write(line)): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const at = (name: LogLevel, tag: string) => (message: string) => {
    if (LOG_LEVELS.indexOf(name) >= threshold) write(`[latch] ${tag}${message}\n`);
  };
  return { debug: at("debug", "debug: "), info: at("info", ""), warn: at("warn", "warning: "), error: at("error", "error: ") };
}
