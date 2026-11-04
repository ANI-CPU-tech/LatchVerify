import { applyEdits, modify, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";

/**
 * JSON with comments and trailing commas, as VS Code, Zed and other clients write their configs.
 * Reading never loses data and editing never loses the user's comments or layout: only the
 * edited value's text changes.
 */

/** The parsed value of `text`, or why it is not valid JSONC (with line and column). A leading BOM is allowed. */
export function parseJsonc(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const source = text.replace(/^﻿/, "");
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  const first = errors[0];
  if (first !== undefined || tree === undefined) {
    return { ok: false, error: first === undefined ? "the file is empty" : `${printParseErrorCode(first.error)} at ${position(source, first.offset)}` };
  }
  return { ok: true, value: valueOf(tree) };
}

/**
 * `text` with the value at `path` set to `value`, creating missing parent objects. Everything
 * else (comments, trailing commas, order, layout) is kept byte for byte; the new value is laid
 * out with the file's own indentation and line endings. When a key is added, a comment that ends
 * the line of the value before it moves after the new key (jsonc-parser inserts right after that
 * value); it is moved, never dropped.
 */
export function setJsonc(text: string, path: readonly string[], value: unknown): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/\n([ \t]+)\S/)?.[1] ?? "  ";
  const formattingOptions = indent.startsWith("\t") ? { insertSpaces: false, tabSize: 1, eol } : { insertSpaces: true, tabSize: indent.length, eol };
  return applyEdits(text, modify(text, [...path], value, { formattingOptions }));
}

/**
 * The plain value of a parse tree. Objects are built with Object.fromEntries, so a "__proto__"
 * key stays an ordinary property (jsonc-parser's own getNodeValue assigns it, setting the
 * prototype). A repeated key keeps its last value, as JSON.parse does.
 */
function valueOf(node: Node): unknown {
  switch (node.type) {
    case "object":
      return Object.fromEntries((node.children ?? []).map((property) => [property.children![0]!.value as string, valueOf(property.children![1]!)]));
    case "array":
      return (node.children ?? []).map(valueOf);
    default:
      return node.value;
  }
}

/** "line L, column C" (1-based) of `offset` in `text`. */
function position(text: string, offset: number): string {
  const before = text.slice(0, offset).split("\n");
  return `line ${before.length}, column ${before.at(-1)!.length + 1}`;
}
