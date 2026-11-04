import { z } from "zod";
import { SUPPORTED_CLIENTS } from "../config/client-ids.js";

/** Each setting's type, without its default: a change must never fill in what it does not name. */
const SETTING_FIELDS = {
  clients: z.partialRecord(z.enum(SUPPORTED_CLIENTS), z.boolean()),
  notifications: z.boolean(),
  checkForUpdates: z.boolean(),
  launchAtLogin: z.boolean(),
  lastUpdateCheck: z.iso.datetime(),
};

/**
 * The user's LatchVerify settings (settings.json beside the per-user latch.lock), read by the
 * background sync and the app, and edited on the Settings page through PUT /api/settings. Every
 * field has a default, so a missing or partial file is a complete set of settings.
 */
export const SettingsSchema = z.object({
  /**
   * The user's answer per client: true to connect it (the background sync links it and the
   * servers added to it later), false for no. A client not listed has not been asked, and is not
   * linked: LatchVerify only notes that it found it.
   */
  clients: SETTING_FIELDS.clients.default({}),
  /** Desktop notifications for changes waiting for review and for blocked calls. */
  notifications: SETTING_FIELDS.notifications.default(true),
  /** Check for a new LatchVerify release once a day. */
  checkForUpdates: SETTING_FIELDS.checkForUpdates.default(true),
  /** Start LatchVerify in the background: when the user logs in, and when an MCP client starts a server. */
  launchAtLogin: SETTING_FIELDS.launchAtLogin.default(true),
  /** When updates were last checked for. */
  lastUpdateCheck: SETTING_FIELDS.lastUpdateCheck.optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * A change to the settings: any subset of the fields; `clients` is merged per client. Built from
 * the bare fields, not SettingsSchema.partial(): zod 4 applies a default inside an optional, so
 * that would turn `{ notifications: false }` into a patch resetting every other setting.
 */
export const SettingsPatchSchema = z.strictObject(SETTING_FIELDS).partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** The settings of a fresh install. */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
