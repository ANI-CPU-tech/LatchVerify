/**
 * WAI-ARIA tabs for every [data-tabs] block: click or arrow keys (Up and Down too when the list is
 * vertical), Home and End. Selecting a tab shows its panel at once. A link to an element inside a
 * hidden panel (download/#source) selects that panel first, so the browser can scroll to it.
 */
export function selectTab(tab: HTMLButtonElement, focus = false): void {
  const list = tab.closest('[role="tablist"]');
  if (!list) return;
  for (const other of list.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const selected = other === tab;
    other.setAttribute("aria-selected", String(selected));
    other.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(other.getAttribute("aria-controls") ?? "");
    if (panel) panel.hidden = !selected;
  }
  if (focus) tab.focus();
}

const KEYS: Record<string, (index: number, last: number) => number> = {
  ArrowRight: (i, last) => (i === last ? 0 : i + 1),
  ArrowDown: (i, last) => (i === last ? 0 : i + 1),
  ArrowLeft: (i, last) => (i === 0 ? last : i - 1),
  ArrowUp: (i, last) => (i === 0 ? last : i - 1),
  Home: () => 0,
  End: (_, last) => last,
};

export function initTabs(): void {
  for (const block of document.querySelectorAll<HTMLElement>("[data-tabs]")) {
    const list = block.querySelector<HTMLElement>('[role="tablist"]');
    if (!list) continue;
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const vertical = list.getAttribute("aria-orientation") === "vertical";
    list.addEventListener("click", (event) => {
      const tab = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]');
      if (tab) selectTab(tab);
    });
    list.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // A horizontal list ignores Up and Down, so the page still scrolls with them.
      if (!vertical && (event.key === "ArrowUp" || event.key === "ArrowDown")) return;
      const move = KEYS[event.key];
      const index = tabs.indexOf(event.target as HTMLButtonElement);
      if (!move || index === -1) return;
      event.preventDefault();
      selectTab(tabs[move(index, tabs.length - 1)]!, true);
    });
  }

  const openTarget = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    const panel = target?.closest<HTMLElement>('[role="tabpanel"]');
    if (!target || !panel?.hidden) return;
    const tab = document.querySelector<HTMLButtonElement>(`[role="tab"][aria-controls="${CSS.escape(panel.id)}"]`);
    if (!tab) return;
    selectTab(tab);
    target.scrollIntoView();
  };
  openTarget();
  window.addEventListener("hashchange", openTarget);
}
