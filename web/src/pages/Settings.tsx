import { useEffect, useState } from "react";
import { PixelLandscape } from "../art/PixelLandscape";
import { CheckIcon } from "../components/icons";
import { PageHeader, Panel, buttonClass } from "../components/ui";
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

      <CardOpacity />

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
