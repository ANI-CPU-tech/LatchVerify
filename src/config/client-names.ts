import type { ClientId } from "./client-ids.js";

/** How each client is named to people. */
export const CLIENT_NAMES: Record<ClientId, string> = {
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
  vscodium: "VSCodium",
  cline: "Cline (VS Code)",
  "cline-cli": "Cline CLI",
  "gemini-cli": "Gemini CLI",
  zed: "Zed",
  "lm-studio": "LM Studio",
  "amazon-q": "Amazon Q Developer",
};
