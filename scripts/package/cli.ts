import { parseArgs } from "node:util";
import { projectVersion } from "./config.js";
import { BuildService } from "./runner.js";
import { TARGET_IDS } from "./targets.js";

const USAGE = `usage: pnpm package <target> [--version <x.y.z>]
       pnpm package --list
       pnpm package --check <target> [--version <x.y.z>]
       pnpm package --release <x.y.z>

targets: ${TARGET_IDS.join(", ")}
Artifacts go to build/packages/<version>/<target>/. Nothing is uploaded or published.`;

const MARK = { pass: "ok  ", fail: "FAIL", skip: "skip" } as const;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      list: { type: "boolean", default: false },
      check: { type: "string" },
      release: { type: "string" },
      version: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const service = new BuildService({ onLog: (_id, line) => console.error(line) });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.list) {
    for (const target of await service.listTargets()) {
      console.log(`${target.available ? "available  " : "unavailable"}  ${target.id.padEnd(18)} ${target.platform}, ${target.format}`);
      for (const check of target.prerequisites.filter((c) => c.status === "fail")) console.log(`               missing ${check.name}: ${check.detail}`);
    }
    return 0;
  }
  if (values.release) {
    const report = await service.prepareRelease(values.release);
    console.log(`release notes and checksums for ${report.targets.join(", ")}:\n${report.files.map((f) => `  ${f}`).join("\n")}`);
    return 0;
  }
  const version = values.version ?? (await projectVersion());
  if (values.check) {
    const { checks, ready } = await service.check(values.check, version);
    for (const check of checks) console.log(`${MARK[check.status]}  ${check.name}: ${check.detail}`);
    console.log(ready ? "ready to build" : "not ready");
    return ready ? 0 : 1;
  }
  const [target, ...extra] = positionals;
  if (!target || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const started = service.start({ target, version, arch: "noarch" });
  await service.idle();
  const job = await service.job(started.id);
  if (job.status !== "succeeded") {
    console.error(`\nbuild failed: ${job.error}`);
    return 1;
  }
  console.log(`\n${job.target} ${job.version} built in ${job.outputDir}:`);
  for (const artifact of job.artifacts) console.log(`  ${artifact.name}  ${artifact.size} bytes  sha256 ${artifact.sha256}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
