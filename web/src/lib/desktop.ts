import { z } from "zod";

/**
 * The LatchVerify app's bridge (src/desktop/preload.cts), present only inside the app's window.
 * In a browser (`latch review --ui`, `pnpm ui`) there is none, and the Settings page says how to
 * update or uninstall from a terminal instead. Every answer is validated before the page uses it.
 */
interface Bridge {
  updateStatus(): Promise<unknown>;
  checkForUpdates(): Promise<unknown>;
  installUpdate(): Promise<unknown>;
  uninstall(): Promise<unknown>;
}

const UpdateStatusSchema = z.object({
  current: z.string(),
  installed: z.boolean(),
  offer: z.object({ version: z.string(), notes: z.string() }).optional(),
  lastCheck: z.string().optional(),
  busy: z.boolean(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

const CheckSchema = z.object({ available: z.boolean(), version: z.string().optional(), error: z.string().optional() });
export type CheckResult = z.infer<typeof CheckSchema>;
const InstallSchema = z.object({ installed: z.boolean(), error: z.string().optional() });
const UninstallSchema = z.object({ started: z.boolean(), error: z.string().optional() });

function bridge(): Bridge | undefined {
  const candidate = (globalThis as { latch?: Partial<Bridge> }).latch;
  return candidate !== undefined && typeof candidate.updateStatus === "function" && typeof candidate.uninstall === "function" ? (candidate as Bridge) : undefined;
}

/** True inside the LatchVerify app. */
export const inDesktopApp = (): boolean => bridge() !== undefined;

const call = async <T>(run: (b: Bridge) => Promise<unknown>, schema: z.ZodType<T>): Promise<T> => {
  const b = bridge();
  if (b === undefined) throw new Error("this needs the LatchVerify app");
  return schema.parse(await run(b));
};

export const updateStatus = () => call((b) => b.updateStatus(), UpdateStatusSchema);
export const checkForUpdates = () => call((b) => b.checkForUpdates(), CheckSchema);
export const installUpdate = () => call((b) => b.installUpdate(), InstallSchema);
export const uninstallApp = () => call((b) => b.uninstall(), UninstallSchema);

/** What a finished check says, in one sentence. */
export function checkSummary(result: CheckResult, current: string): string {
  if (result.error !== undefined) return `Could not check for updates: ${result.error}.`;
  return result.available && result.version !== undefined ? `LatchVerify ${result.version} is available.` : `LatchVerify ${current} is the latest release.`;
}
