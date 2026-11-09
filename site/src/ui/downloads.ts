import { detectPlatform, suggestedPackage, type Platform } from "../lib/platform.js";
import { LATEST_RELEASE_API, compareVersions, formatBytes, parseRelease, releaseFields, type PackageKind, type Release } from "../lib/release.js";
import { selectTab } from "./tabs.js";

/** The API's answer is kept for a few minutes, so moving between pages does not ask again. */
const CACHE_KEY = "latchverify.site.release";
const CACHE_MS = 10 * 60 * 1000;

const NAMES: Record<PackageKind, string> = {
  windows: "Windows",
  deb: "Debian and Ubuntu",
  arch: "Arch and CachyOS",
  tarball: "Linux",
};

const LINUX_KINDS: readonly PackageKind[] = ["deb", "arch", "tarball"];

/** The release the page was built with (plugin/template.ts releaseScript). */
function builtRelease(): Release | null {
  try {
    const json: unknown = JSON.parse(document.getElementById("lv-release")?.textContent ?? "null");
    return json && typeof json === "object" && "version" in json && "files" in json ? (json as Release) : null;
  } catch {
    return null;
  }
}

function sessionCache(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The latest release from the GitHub API, or null when it cannot be had (offline, rate limit). */
async function liveRelease(): Promise<Release | null> {
  const cache = sessionCache();
  try {
    const cached = JSON.parse(cache?.getItem(CACHE_KEY) ?? "null") as { at?: unknown; json?: unknown } | null;
    if (cached && typeof cached.at === "number" && Date.now() - cached.at < CACHE_MS) return parseRelease(cached.json);
  } catch {
    // An unreadable entry is ignored and replaced below.
  }
  try {
    const response = await fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    try {
      cache?.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), json }));
    } catch {
      // Storage full or blocked: the page works without the cache.
    }
    return parseRelease(json);
  } catch {
    return null;
  }
}

/** Writes a release into every element marked with one of its fields. */
function show(release: Release): void {
  const fields = releaseFields(release);
  const set = (element: HTMLElement, key: string, field: string) => {
    const value = fields.get(key);
    if (value === undefined) return;
    if (field === "url" || field === "sums") element.setAttribute("href", value);
    else element.textContent = value;
  };
  for (const element of document.querySelectorAll<HTMLElement>("[data-release]")) set(element, `release.${element.dataset.release}`, element.dataset.release!);
  for (const element of document.querySelectorAll<HTMLElement>("[data-file][data-field]")) {
    set(element, `file.${element.dataset.file}.${element.dataset.field}`, element.dataset.field!);
  }
}

/** The hero's main button: the file for this system when there is one, else the right part of the download page. */
function suggestOnHome(release: Release, platform: Platform, kind: PackageKind | null): void {
  const button = document.querySelector<HTMLAnchorElement>("[data-download-suggested]");
  const label = button?.querySelector("[data-download-label]");
  const note = document.querySelector<HTMLElement>("[data-download-note]");
  if (!button || !label || !note) return;
  const file = kind ? release.files[kind] : undefined;
  const otherSystems = () => {
    const link = document.createElement("a");
    link.href = "download/";
    link.textContent = "Other systems";
    return link;
  };
  if (kind && file) {
    button.href = file.url;
    label.textContent = `Download for ${NAMES[kind]}`;
    const facts = [`v${release.version}`, file.size ? formatBytes(file.size) : null, file.name].filter(Boolean).join(" · ");
    note.replaceChildren(`${facts}. `, otherSystems());
  } else if (platform === "linux") {
    button.href = "download/";
    label.textContent = "Download for Linux";
    note.replaceChildren("Packages for Debian and Ubuntu, and for Arch and CachyOS, plus a portable archive for any x64 distribution.");
  } else if (platform === "mac") {
    button.href = "download/#source";
    label.textContent = "Build it on macOS";
    note.replaceChildren("There is no macOS package yet; LatchVerify runs there from source. ", otherSystems());
  }
}

/** On the download page: say which package fits, mark its card and open its install steps. */
function suggestOnDownloadPage(platform: Platform, kind: PackageKind | null): void {
  const line = document.querySelector<HTMLElement>("[data-suggestion]");
  if (!line) return;
  const marked: readonly PackageKind[] = kind ? [kind] : platform === "linux" ? LINUX_KINDS : [];
  for (const card of document.querySelectorAll<HTMLElement>(".package[data-package]")) {
    if (!marked.includes(card.dataset.package as PackageKind)) continue;
    card.setAttribute("data-suggested", "");
    const badge = document.createElement("span");
    badge.className = "suggested-badge";
    badge.textContent = "For your system";
    card.querySelector(".package-head")?.append(badge);
  }
  const messages: Partial<Record<Platform, string>> = {
    windows: "You seem to be on Windows: the setup EXE is marked below.",
    linux: kind
      ? `You seem to be on ${NAMES[kind]}: its package is marked below.`
      : "You seem to be on Linux: pick the package for your distribution, or the portable archive for any of them.",
    mac: "You seem to be on a Mac. There is no macOS package yet; the steps to build from source are below.",
    mobile: "Open this page on the computer you want to protect: the packages are for Windows and Linux.",
  };
  const message = messages[platform];
  if (message) {
    line.textContent = message;
    line.hidden = false;
  }
  // Open the matching install steps, unless a link already asked for a section.
  if (location.hash) return;
  const tabFor = platform === "mac" ? "source" : (kind ?? (platform === "linux" ? "deb" : null));
  const tab = tabFor ? document.querySelector<HTMLButtonElement>(`[data-tab-package="${tabFor}"]`) : null;
  if (tab) selectTab(tab);
}

export function initDownloads(): void {
  const built = builtRelease();
  if (!built) return;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = detectPlatform(navigator.userAgent, nav.userAgentData?.platform);
  const kind = suggestedPackage(platform, navigator.userAgent);
  suggestOnHome(built, platform, kind);
  suggestOnDownloadPage(platform, kind);

  void liveRelease().then((live) => {
    // Only a release at least as new as the built one: the API is a refresh, never a downgrade.
    if (!live || compareVersions(live.version, built.version) < 0) return;
    show(live);
    suggestOnHome(live, platform, kind);
  });
}
