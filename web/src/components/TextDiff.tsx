import type { DiffPart } from "../lib/api";

/** Renders a precomputed jsdiff word diff of the tool description. Secondary to CapabilityDiff. */
export function TextDiff({ parts }: { parts: DiffPart[] }) {
  return (
    <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
      {parts.map((part, i) => (
        <span
          key={i}
          className={
            part.added
              ? "bg-success/15 text-success"
              : part.removed
                ? "bg-destructive/15 text-destructive line-through"
                : undefined
          }
        >
          {part.value}
        </span>
      ))}
    </p>
  );
}
