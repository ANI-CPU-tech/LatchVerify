import "./styles/main.css";
import { initCopy } from "./ui/copy.js";
import { initDownloads } from "./ui/downloads.js";
import { initHeroArt, initReveal, initTerminals } from "./ui/effects.js";
import { initNav } from "./ui/nav.js";
import { initTabs } from "./ui/tabs.js";
import { initTheme } from "./ui/theme.js";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

initTheme(reducedMotion);
initNav();
initTabs();
initCopy();
initDownloads();
initHeroArt();
if (!reducedMotion) {
  initReveal();
  initTerminals();
}
