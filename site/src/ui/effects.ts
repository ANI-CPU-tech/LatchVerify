/**
 * Motion on scroll, for viewers who have not asked for less (main.ts checks): sections rise in as
 * they arrive, terminals print their lines one after another, and the hero's animation pauses
 * while it is off screen. Each effect hides content only after its class is set on <html> here,
 * so if this script never runs, everything is simply visible.
 */
export function initReveal(): void {
  const items = document.querySelectorAll<HTMLElement>(".reveal");
  if (items.length === 0 || !("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("reveal-anim");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const item of items) observer.observe(item);
}

export function initTerminals(): void {
  const terminals = document.querySelectorAll<HTMLElement>("[data-term]");
  if (terminals.length === 0 || !("IntersectionObserver" in window)) return;
  for (const terminal of terminals) {
    terminal.querySelectorAll<HTMLElement>(".line").forEach((line, i) => line.style.setProperty("--i", String(i)));
  }
  document.documentElement.classList.add("term-anim");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-played");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.25 },
  );
  for (const terminal of terminals) observer.observe(terminal);
}

export function initHeroArt(): void {
  const art = document.querySelector<HTMLElement>("[data-hero-art]");
  if (!art || !("IntersectionObserver" in window)) return;
  new IntersectionObserver(([entry]) => art.classList.toggle("is-paused", !entry?.isIntersecting)).observe(art);
}
