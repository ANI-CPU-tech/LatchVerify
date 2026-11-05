import type { Writable } from "node:stream";
import pc from "picocolors";
import { installKind, privilegeFailure, runUninstall, uninstallCommand } from "../update/index.js";

/**
 * `latch uninstall`: remove this installed LatchVerify with its own uninstaller (the Windows
 * uninstaller, apt-get or pacman through pkexec, or the portable install's uninstall.sh). Each
 * first gives every MCP client its original server commands back; latch.lock is kept. Without
 * --yes it only says what it would run. A source checkout is not uninstalled here.
 */
export async function runUninstallCommand(options: { yes: boolean; output?: Writable }): Promise<number> {
  const out = options.output ?? process.stdout;
  const say = (line = "") => void out.write(`${line}\n`);
  const install = installKind();
  if (install === undefined) {
    say("This LatchVerify is not an installed release (no install-kind marker), so there is nothing to uninstall: delete the checkout instead.");
    return 1;
  }
  const { command, args } = uninstallCommand(install.kind, install.root);
  if (!options.yes) {
    say(`This removes LatchVerify from ${install.root}. Every MCP client gets its original server commands back; your latch.lock is kept.`);
    say(`It runs: ${[command, ...args].join(" ")}`);
    say("Run `latch uninstall --yes` to go ahead.");
    return 0;
  }
  const code = await runUninstall(install.kind, install.root);
  if (code === 0) {
    say(`${pc.green("✔")} ${install.kind === "inno" ? "the LatchVerify uninstaller is open" : "LatchVerify was removed; your latch.lock was kept"}`);
    return 0;
  }
  say(pc.red(`✖ ${privilegeFailure(install.kind, code) ?? `the uninstaller exited with ${code}`}`));
  return 1;
}
