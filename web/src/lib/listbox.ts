/**
 * Keyboard behaviour of the themed Select's open listbox (WAI-ARIA select-only combobox): what a
 * key does given the highlighted option. Pure, so tests/web can check it in node.
 */
export type ListboxAction =
  | { kind: "move"; to: number }
  | { kind: "choose" }
  | { kind: "close" }
  | null;

export function listboxKey(key: string, active: number, count: number): ListboxAction {
  if (count === 0) return key === "Escape" || key === "Tab" ? { kind: "close" } : null;
  switch (key) {
    case "ArrowDown":
      return { kind: "move", to: Math.min(count - 1, active + 1) };
    case "ArrowUp":
      return { kind: "move", to: Math.max(0, active - 1) };
    case "Home":
    case "PageUp":
      return { kind: "move", to: 0 };
    case "End":
    case "PageDown":
      return { kind: "move", to: count - 1 };
    case "Enter":
    case " ":
      return { kind: "choose" };
    case "Escape":
    case "Tab":
      return { kind: "close" };
    default:
      return null;
  }
}

/**
 * Type-to-jump: the next option after `from` whose label starts with `char` (case-insensitive),
 * wrapping around, or null when none does or `char` is not a single printable character.
 */
export function typeaheadIndex(labels: readonly string[], char: string, from: number): number | null {
  if ([...char].length !== 1 || char.trim() === "") return null;
  const wanted = char.toLowerCase();
  for (let step = 1; step <= labels.length; step++) {
    const i = (from + step) % labels.length;
    if (labels[i]!.toLowerCase().startsWith(wanted)) return i;
  }
  return null;
}
