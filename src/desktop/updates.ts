import type { DesktopNotification } from "../daemon/notify.js";
import type { Logger } from "../log.js";

/** What the window and the tray can do about updates. Phase 6 (src/update/) fills these in. */
export interface UpdateHandlers {
  check(byUser: boolean): Promise<{ available: boolean; version?: string; error?: string }>;
  install(): Promise<{ installed: boolean; error?: string }>;
  /** The tray item's label. */
  label(): string;
  /** Starts the automatic checks; `changed` refreshes the tray. */
  schedule(changed: () => void): void;
}

export function updateHandlers(_deps: { notify: (notification: DesktopNotification) => Promise<void>; showWindow: (route?: string) => void; log: Logger }): UpdateHandlers {
  return {
    check: async () => ({ available: false, error: "updates are not set up in this build" }),
    install: async () => ({ installed: false, error: "updates are not set up in this build" }),
    label: () => "Check for updates",
    schedule: () => undefined,
  };
}
