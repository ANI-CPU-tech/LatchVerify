import { formatCodepoint } from "../analyze/unicode.js";

/**
 * Text safe to print on a terminal: control and format characters (escape sequences, bidi
 * overrides, zero-width characters, line separators) become [U+XXXX]. Other Unicode is kept.
 * Use it for every string a server or a file controls.
 */
export function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => `[${formatCodepoint(char.codePointAt(0)!)}]`);
}

/** "1 tool", "2 tools"; pass `many` for irregular plurals ("entries"). */
export function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`;
}
