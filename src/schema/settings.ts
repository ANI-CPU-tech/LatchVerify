import { z } from "zod";
import { SUPPORTED_CLIENTS } from "../config/client-ids.js";

/**
 * The user's LatchVerify settings (settings.json beside the per-user latch.lock), read by the
 * background sync and the app, and edited on the Settings page through PUT /api/settings. Every
 * field has a default, so a missing or partial file is a complete set of settings.
 */
export const SettingsSchema = z.object({
  /** Clients the background sync links, by id. A client not listed is linked: off is an explicit choice. */
  clients: z.partialRecord(z.enum(SUPPORTED_CLIENTS), z.boolean()).default({}),
  /** Desktop notifications for changes waiting for review and for blocked calls. */
  notifications: z.boolean().default(true),
  /** Check for a new LatchVerify release once a day. */
  checkForUpdates: z.boolean().default(true),
  /** Start LatchVerify when the user logs in. */
  launchAtLogin: z.boolean().default(true),
  /** When updates were last checked for. */
  lastUpdateCheck: z.iso.datetime().optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** A change to the settings: any subset of the fields; `clients` is merged per client. */
export const SettingsPatchSchema = SettingsSchema.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** The settings of a fresh install. */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
