/**
 * The header: a border once the page scrolls, the menu on narrow screens, and on the home page
 * the link of the section in view marked as the current location.
 */
export function initNav(): void {
  const header = document.querySelector<HTMLElement>("[data-header]");
  if (!header) return;

  const onScroll = () => header.toggleAttribute("data-scrolled", window.scrollY > 4);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const toggle = header.querySelector<HTMLButtonElement>("[data-nav-toggle]");
  const menu = header.querySelector<HTMLElement>("[data-nav-menu]");
  if (toggle && menu) {
    const setOpen = (open: boolean) => {
      header.toggleAttribute("data-open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    toggle.addEventListener("click", () => setOpen(!header.hasAttribute("data-open")));
    menu.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && header.hasAttribute("data-open")) {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener("click", (event) => {
      if (header.hasAttribute("data-open") && !header.contains(event.target as Node)) setOpen(false);
    });
    // Back to a wide layout, the menu is inline again: drop the open state.
    matchMedia("(min-width: 960px)").addEventListener("change", (event) => {
      if (event.matches) setOpen(false);
    });
  }

  const links = [...header.querySelectorAll<HTMLAnchorElement>("a[data-spy]")];
  const sections = links
    .map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))))
    .filter((section): section is HTMLElement => section !== null);
  if (sections.length === 0 || !("IntersectionObserver" in window)) return;

  const visible = new Set<Element>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      // The first section in page order that crosses the band in the middle of the screen.
      const active = sections.find((section) => visible.has(section));
      for (const link of links) {
        if (active && link.hash === `#${active.id}`) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
    },
    { rootMargin: "-40% 0px -55% 0px" },
  );
  for (const section of sections) observer.observe(section);
}
