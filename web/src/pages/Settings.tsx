import { useState } from "react";
import { CheckIcon } from "../components/icons";
import { PageHeader, Panel } from "../components/ui";
import { useTheme } from "../lib/theme";
import { SYSTEM_THEMES, THEMES, type ThemeId, type ThemePreference } from "../lib/themes";

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
                  className={`relative cursor-pointer rounded-lg border p-2 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${
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

      <Panel title="About this screen">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Data comes from the local review API on 127.0.0.1, which reads latch.lock and the .latch/ directory.</li>
          <li>Approve and Reject call that API; the proxy enforces latch.lock whether or not this screen is open.</li>
          <li>Nothing is sent anywhere else. The theme choice stays in this browser.</li>
        </ul>
      </Panel>
    </>
  );
}
