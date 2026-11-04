import type { Writable } from "node:stream";
import pc from "picocolors";
import { VERSION } from "../version.js";
import { checkForUpdate, download, installKind, runInstall, type Offer } from "../update/index.js";
import { printable } from "./text.js";

/** What a release offers, for the terminal. Line by line through printable(), so its text carries no terminal escapes. */
export function offerLines(offer: Offer, current: string): string[] {
  const notes = offer.notes.trim();
  return [pc.bold(`LatchVerify ${printable(offer.version)} is available (you have ${current})`), ...(notes === "" ? [] : notes.split(/\r?\n/).map(printable))];
}

/**
 * `latch update`: install the newest release, signed by the release key, for this install's kind
 * (Windows installer, deb, pacman package or portable archive). `--check` only says whether one
 * is available. A source checkout is updated with git, not here.
 */
export async function runUpdate(options: { check: boolean; output?: Writable }): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const install = installKind();
  if (install === undefined) {
    say("This LatchVerify is not an installed release (no install-kind marker), so it does not update itself: use git pull and pnpm build.");
    return options.check ? 0 : 1;
  }
  const offer = await checkForUpdate(install.kind);
  if (offer === undefined) {
    say(`${pc.green("✔")} LatchVerify ${VERSION} is the latest release`);
    return 0;
  }
  for (const line of offerLines(offer, VERSION)) say(line);
  if (options.check) {
    say("Run `latch update` to install it.");
    return 0;
  }
  say(`downloading ${printable(offer.url)}`);
  const file = await download(offer);
  say(`${pc.green("✔")} checksum and signature verified; installing`);
  const code = await runInstall(offer.kind, file, install.root);
  say(code === 0 ? `${pc.green("✔")} installed LatchVerify ${offer.version}; restart your MCP clients and the app` : pc.red(`✖ the installer exited with ${code}`));
  return code === 0 ? 0 : 1;
}
