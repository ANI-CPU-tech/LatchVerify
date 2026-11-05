import { useCallback, useEffect, useState } from "react";
import { PixelLandscape } from "../art/PixelLandscape";
import { CheckIcon, RefreshIcon } from "../components/icons";
import type { SettingsPatch } from "@schema/index.js";
import { PageHeader, Panel, Switch, Terminal, buttonClass } from "../components/ui";
import { saveSettings } from "../lib/api";
import { describeError, useData } from "../lib/data";
import { checkForUpdates, checkSummary, inDesktopApp, installUpdate, uninstallApp, updateStatus, type UpdateStatus } from "../lib/desktop";
import { relativeTime } from "../lib/format";
import { href } from "../lib/router";
import { useTheme } from "../lib/theme";
import { DEFAULT_SURFACE, SURFACE_STEP, surfaceAlpha } from "../lib/surface";
import { SYSTEM_THEMES, THEMES, sceneFor, type ThemeId, type ThemePreference } from "../lib/themes";

/**
 * A miniature of the app drawn with `theme`'s own tokens: data-theme on this element scopes the
 * CSS variables (index.css) to it, so the preview is the real palette, not a copy of it.
 */
function ThemePreview({ theme }: { theme: ThemeId }) {
  return (
    <div data-theme={theme} aria-hidden="true" className="flex h-20 overflow-hidden rounded-md border bg-background">
      <div className="w-1/4 space-y-1 border-r bg-sidebar p-1.5">
        <div className="h-1.5 rounded-sm bg-primary" />
        <div className="h-1.5 rounded-sm bg-muted-foreground/30" />
        <div className="h-1.5 rounded-sm bg-muted-foreground/30" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-1.5">
        <div className="flex gap-1">
          <div className="h-4 flex-1 rounded-sm border bg-card" />
          <div className="h-4 flex-1 rounded-sm border border-destructive/40 bg-destructive/10" />
          <div className="h-4 flex-1 rounded-sm border bg-card" />
        </div>
        <div className="flex flex-1 gap-1">
          <div className="flex-1 rounded-sm border bg-card p-1">
            <div className="h-1 w-3/4 rounded-sm bg-foreground/70" />
            <div className="mt-1 h-1 w-1/2 rounded-sm bg-muted-foreground/50" />
          </div>
          <div className="w-1/3 rounded-sm bg-terminal p-1">
            <div className="h-1 w-3/4 rounded-sm bg-terminal-accent" />
            <div className="mt-1 h-1 w-1/2 rounded-sm bg-terminal-foreground/70" />
          </div>
        </div>
      </div>
    </div>
  );
}

const OPTIONS: Array<{ id: ThemePreference; label: string; description: string }> = [
  ...THEMES,
  {
    id: "system",
    label: "Follow system",
    description: `${THEMES.find((t) => t.id === SYSTEM_THEMES.light)!.label} or ${THEMES.find((t) => t.id === SYSTEM_THEMES.dark)!.label}`,
  },
];

/** The active theme's card opacity floor (--surface-alpha), read once the theme is applied. */
function useSurfaceFloor(theme: ThemeId): number | null {
  const [floor, setFloor] = useState<number | null>(null);
  useEffect(() => {
    // The provider sets data-theme in its own effect, which runs after this one: read next frame.
    const frame = requestAnimationFrame(() => {
      const value = Number(getComputedStyle(document.documentElement).getPropertyValue("--surface-alpha"));
      setFloor(Number.isFinite(value) && value > 0 ? value : null);
    });
    return () => cancelAnimationFrame(frame);
  }, [theme]);
  return floor;
}

/** Card opacity: from the theme's readable floor to solid, with a live preview over the landscape. */
function CardOpacity() {
  const { theme, surface, setSurface } = useTheme();
  const [notSaved, setNotSaved] = useState(false);
  const floor = useSurfaceFloor(theme);
  const percent = floor === null ? null : Math.round(surfaceAlpha(floor, surface) * 100);
  const scene = sceneFor(theme);
  const change = (value: number) => setNotSaved(!setSurface(value).saved);

  return (
    <Panel title="Card transparency">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            How much of the landscape shows through cards. The most see-through setting is the lowest opacity at which every text
            color in this theme still meets WCAG AA contrast, so text stays readable at any setting.
          </p>
          <label htmlFor="card-opacity" className="flex items-baseline justify-between gap-2 text-sm font-medium">
            Card opacity
            <span className="font-mono text-xs text-muted-foreground">{percent === null ? "—" : `${percent}% opaque`}</span>
          </label>
          <input
            id="card-opacity"
            type="range"
            min={0}
            max={100}
            step={SURFACE_STEP * 100}
            value={Math.round(surface * 100)}
            onChange={(event) => change(Number(event.target.value) / 100)}
            aria-valuetext={percent === null ? undefined : `${percent}% opaque`}
            className="w-full accent-[hsl(var(--primary))]"
          />
          <div className="flex justify-between text-xs text-muted-foreground" aria-hidden="true">
            <span>See-through</span>
            <span>Solid</span>
          </div>
          <button type="button" onClick={() => change(DEFAULT_SURFACE)} disabled={surface === DEFAULT_SURFACE} className={buttonClass("secondary", "sm")}>
            Use the theme default
          </button>
          {notSaved && (
            <p role="status" className="text-sm text-warning">
              This browser blocked local storage, so the setting applies now but will not be remembered.
            </p>
          )}
        </div>

        <div aria-hidden="true" className="relative h-44 overflow-hidden rounded-md border bg-gradient-to-b from-art-sky to-art-horizon">
          <PixelLandscape time={scene.time} extra={scene.extra} className="absolute inset-x-0 bottom-0 h-full w-full" />
          <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 space-y-1 rounded-lg border bg-card-glass p-3 shadow-card backdrop-blur-sm">
            <p className="text-sm font-medium text-foreground">Preview card</p>
            <p className="text-xs text-muted-foreground">Muted text stays readable.</p>
            <p className="text-xs text-primary">So do links and status colors.</p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** The background choices kept in settings.json, saved through the API as soon as they change. */
function Background() {
  const { settings, api, reload } = useData();
  const [saving, setSaving] = useState<keyof SettingsPatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = settings.status === "ready" ? settings.data : null;
  const change = async (key: "notifications" | "checkForUpdates" | "launchAtLogin", value: boolean) => {
    setSaving(key);
    setError(null);
    try {
      await saveSettings({ [key]: value });
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(null);
    }
  };
  const rows: Array<{ key: "notifications" | "checkForUpdates" | "launchAtLogin"; label: string; detail: string }> = [
    { key: "notifications", label: "Desktop notifications", detail: "When a tool change waits for review, when a call is blocked, and when a new MCP client is found." },
    { key: "checkForUpdates", label: "Check for updates", detail: "Once a day. Nothing is downloaded or installed without your click." },
    { key: "launchAtLogin", label: "Start in the background", detail: "At login, and when an MCP client starts a server, so LatchVerify keeps watching your MCP clients." },
  ];
  return (
    <Panel title="Background">
      {current === null ? (
        <p className="text-sm text-muted-foreground">{api === "unreachable" ? "The review API is not running, so these settings cannot be read." : "Loading settings..."}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
              <div>
                <label htmlFor={`setting-${row.key}`} className="text-sm font-medium">
                  {row.label}
                </label>
                <p className="text-xs text-muted-foreground">{row.detail}</p>
              </div>
              <Switch id={`setting-${row.key}`} label={row.label} checked={current[row.key]} disabled={saving !== null} onChange={(next) => void change(row.key, next)} />
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Which MCP clients are connected is chosen on the <a className="text-primary hover:underline" href={href({ page: "servers" })}>MCP Servers</a> page.
      </p>
    </Panel>
  );
}

/**
 * Updates, inside the app: check now, then install the release on one click. The app downloads it,
 * checks its signature and checksum, installs it and restarts. In a browser: `latch update`.
 */
function Updates() {
  const { info } = useData();
  const desktop = inDesktopApp();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "installing">("idle");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await updateStatus());
    } catch (failure) {
      setMessage({ tone: "error", text: describeError(failure) });
    }
  }, []);
  useEffect(() => {
    if (desktop) void refresh();
  }, [desktop, refresh]);

  const current = status?.current ?? (info.status === "ready" ? info.data.version : null);
  const check = async () => {
    setPhase("checking");
    setMessage(null);
    try {
      const result = await checkForUpdates();
      setMessage({ tone: result.error === undefined ? "ok" : "error", text: checkSummary(result, current ?? "") });
      await refresh();
    } catch (failure) {
      setMessage({ tone: "error", text: describeError(failure) });
    } finally {
      setPhase("idle");
    }
  };
  const install = async () => {
    setPhase("installing");
    setMessage(null);
    try {
      const result = await installUpdate();
      // On success the app restarts (or the Windows installer takes over) before this returns.
      if (!result.installed) setMessage({ tone: "error", text: `The update was not installed: ${result.error ?? "it was cancelled"}.` });
    } catch (failure) {
      setMessage({ tone: "error", text: describeError(failure) });
    } finally {
      setPhase("idle");
    }
  };

  const offer = status?.offer;
  return (
    <Panel title="Updates">
      <div className="space-y-3">
        <p className="text-sm">
          You have LatchVerify <span className="font-mono">{current ?? "..."}</span>
          {status?.lastCheck && <span className="text-muted-foreground"> · last checked {relativeTime(status.lastCheck)}</span>}
        </p>
        {!desktop ? (
          <>
            <p className="text-sm text-muted-foreground">Updates install from the LatchVerify app. In a terminal:</p>
            <Terminal>latch update</Terminal>
          </>
        ) : status !== null && !status.installed ? (
          <p className="text-sm text-muted-foreground">This LatchVerify was built from source, so it does not update itself: use git pull and pnpm build.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Every release is signed. Nothing is downloaded until you click Install, and the download is checked against the signed
              checksum before it runs. On Linux your system asks for your password.
            </p>
            {offer && (
              <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
                <p className="text-sm font-medium">LatchVerify {offer.version} is available</p>
                {offer.notes.trim() !== "" && <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-sans text-xs text-muted-foreground">{offer.notes.trim()}</pre>}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {offer && (
                <button type="button" onClick={() => void install()} disabled={phase !== "idle" || status?.busy === true} className={buttonClass("primary")}>
                  {phase === "installing" && <RefreshIcon aria-hidden="true" className="motion-safe:animate-spin" />}
                  {phase === "installing" ? "Installing..." : `Install ${offer.version} and restart`}
                </button>
              )}
              <button type="button" onClick={() => void check()} disabled={phase !== "idle" || status === null} className={buttonClass("secondary")}>
                {phase === "checking" && <RefreshIcon aria-hidden="true" className="motion-safe:animate-spin" />}
                {phase === "checking" ? "Checking..." : "Check for updates"}
              </button>
            </div>
          </>
        )}
        {message && (
          <p role={message.tone === "error" ? "alert" : "status"} className={`text-sm ${message.tone === "error" ? "text-destructive" : "text-success"}`}>
            {message.text}
          </p>
        )}
      </div>
    </Panel>
  );
}

/** Development mode: the Simulation and Dev Tools pages, saved in settings.json. --dev and LATCH_DEV still force it on. */
function Development() {
  const { settings, info, reload } = useData();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = info.status === "ready" && info.data.devLocked;
  const current = settings.status === "ready" ? settings.data.devMode : null;
  const change = async (devMode: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings({ devMode });
      reload();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="Development">
      <div className="flex items-center justify-between gap-4">
        <div>
          <label htmlFor="setting-devMode" className="text-sm font-medium">
            Development mode
          </label>
          <p className="text-xs text-muted-foreground">
            {locked
              ? "On for this run: LatchVerify was started with --dev or LATCH_DEV=1. Start it without them to use this switch."
              : "Adds the Simulation and Dev Tools pages. The demo servers they use come only with a source checkout."}
          </p>
        </div>
        <Switch id="setting-devMode" label="Development mode" checked={locked || current === true} disabled={locked || current === null || saving} onChange={(next) => void change(next)} />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </Panel>
  );
}

/** Uninstall, inside the installed app; the app asks before anything is removed. */
function Uninstall() {
  const desktop = inDesktopApp();
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (desktop) void updateStatus().then((status) => setInstalled(status.installed), () => setInstalled(false));
  }, [desktop]);
  const uninstall = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await uninstallApp();
      if (result.error !== undefined) setError(result.error);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Uninstall">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Removes LatchVerify. Every MCP client gets its original server commands back first, so its servers then start without these checks.
          Your latch.lock and settings are kept, so a reinstall keeps your approvals.
        </p>
        {desktop && installed ? (
          <button type="button" onClick={() => void uninstall()} disabled={busy} className={buttonClass("danger")}>
            {busy ? "Uninstalling..." : "Uninstall LatchVerify..."}
          </button>
        ) : (
          <Terminal>latch uninstall --yes</Terminal>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

export function Settings() {
  const { preference, setPreference } = useTheme();
  const [notSaved, setNotSaved] = useState(false);

  return (
    <>
      <PageHeader title="Settings" />
      <Panel title="Appearance">
        <fieldset>
          <legend className="text-sm text-muted-foreground">
            Choose a theme. It applies at once and is remembered in this browser. Themes change colors only, never what is blocked or
            approved.
          </legend>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {OPTIONS.map((option) => {
              const checked = preference === option.id;
              return (
                <label
                  key={option.id}
                  className={`relative cursor-pointer rounded-lg border p-2 transition-[color,background-color,border-color,transform] duration-200 ease-out motion-safe:hover:-translate-y-0.5 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${
                    checked ? "border-primary bg-primary/5" : "hover:border-input"
                  }`}
                >
                  <input
                    type="radio"
                    name="theme"
                    value={option.id}
                    checked={checked}
                    onChange={() => setNotSaved(!setPreference(option.id).saved)}
                    className="sr-only"
                  />
                  {option.id === "system" ? (
                    <div className="grid grid-cols-2 gap-1">
                      <ThemePreview theme={SYSTEM_THEMES.light} />
                      <ThemePreview theme={SYSTEM_THEMES.dark} />
                    </div>
                  ) : (
                    <ThemePreview theme={option.id} />
                  )}
                  <span className="mt-2 flex items-center justify-between gap-2 px-1">
                    <span>
                      <span className="block text-sm font-medium">{option.label}</span>
                      <span className="block text-xs text-muted-foreground">{option.description}</span>
                    </span>
                    {checked && (
                      <span className="text-lg text-primary">
                        <CheckIcon />
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          {notSaved && (
            <p role="status" className="mt-3 text-sm text-warning">
              This browser blocked local storage, so the theme applies now but will not be remembered.
            </p>
          )}
        </fieldset>
      </Panel>

      <Background />
      <Updates />
      <CardOpacity />
      <Development />
      <Uninstall />

      <Panel title="About this screen">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Data comes from the local review API on 127.0.0.1, which reads latch.lock and the .latch/ directory.</li>
          <li>Approve and Reject call that API; the proxy enforces latch.lock whether or not this screen is open.</li>
          <li>Nothing is sent anywhere else. The theme and card opacity stay in this browser.</li>
        </ul>
      </Panel>
    </>
  );
}
