import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { listboxKey, typeaheadIndex } from "../lib/listbox";
import { CheckIcon, ChevronRightIcon } from "./icons";

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A dropdown drawn with theme tokens, in place of a native <select> whose popup the OS paints
 * in its own colors. WAI-ARIA select-only combobox: a button that opens a listbox. Arrow keys,
 * Enter or Space open it; in it, arrows, Home and End move, Enter or Space choose, Escape or Tab
 * close, and typing a letter jumps to the next option starting with it. A click outside closes
 * it. Pair it with a <label htmlFor={id}>: a button is labelable.
 */
export function Select({
  id,
  value,
  options,
  onChange,
  size = "md",
  className = "",
}: {
  id: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  const [active, setActiveState] = useState(selected);
  // Mirrors `active` synchronously, so Enter right after an arrow key chooses what it highlighted
  // even before React has re-rendered.
  const activeRef = useRef(selected);
  const setActive = (index: number) => {
    activeRef.current = index;
    setActiveState(index);
  };
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const show = () => {
    setActive(selected);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    if (option && option.value !== value) onChange(option.value);
    close(true);
  };

  // Focus the list when it opens, and keep the highlighted option in view.
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // A press anywhere outside closes it, leaving focus where the press put it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      show();
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const action = listboxKey(event.key, activeRef.current, options.length);
    if (action === null) {
      const jump = typeaheadIndex(
        options.map((option) => option.label),
        event.key,
        activeRef.current,
      );
      if (jump !== null) setActive(jump);
      return;
    }
    if (action.kind !== "close" || event.key === "Escape") event.preventDefault();
    if (action.kind === "move") setActive(action.to);
    else if (action.kind === "choose") choose(activeRef.current);
    else close(event.key === "Escape");
  };

  return (
    <div ref={root} className={`relative inline-block ${className}`}>
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onButtonKeyDown}
        className={`flex w-full items-center justify-between gap-2 rounded-md border border-input bg-card text-left text-foreground transition-[border-color,box-shadow] duration-150 hover:border-primary/50 ${
          open ? "border-primary/60 shadow-card" : ""
        } ${size === "sm" ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-sm"}`}
      >
        <span className="truncate">{options[selected]?.label}</span>
        <span className={`shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "-rotate-90" : "rotate-90"}`}>
          <ChevronRightIcon />
        </span>
      </button>
      {open && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={id}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKeyDown}
          className={`absolute left-0 top-full z-30 mt-1 max-h-64 min-w-full origin-top overflow-auto rounded-md border bg-card p-1 shadow-card outline-none motion-safe:animate-[ui-pop_0.14s_ease-out] ${
            size === "sm" ? "text-xs" : "text-sm"
          }`}
        >
          {options.map((option, i) => {
            const isSelected = i === selected;
            return (
              <li
                key={option.value}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={isSelected}
                onPointerMove={() => setActive(i)}
                onClick={() => choose(i)}
                className={`flex cursor-pointer items-center justify-between gap-3 whitespace-nowrap rounded-sm px-2 py-1.5 ${
                  i === active ? "bg-muted text-foreground" : "text-foreground"
                } ${isSelected ? "font-medium text-primary" : ""}`}
              >
                {option.label}
                <span className={isSelected ? "text-primary" : "invisible"} aria-hidden="true">
                  <CheckIcon />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
