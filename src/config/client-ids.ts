// The supported client ids, apart from clients.ts so `latch` can offer them as --client choices
// without loading the config reader and writer at startup.

/** MCP clients whose config files `latch init` knows how to rewrite. */
export const SUPPORTED_CLIENTS = [
  "claude-desktop",
  "claude-code",
  "cursor",
  "vscode",
  "vscode-insiders",
  "vscodium",
  "cline",
  "cline-cli",
  "gemini-cli",
  "zed",
  "lm-studio",
  "amazon-q",
] as const;
export type ClientId = (typeof SUPPORTED_CLIENTS)[number];
