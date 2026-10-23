import type { DiffPart } from "../lib/api";

/** Renders a precomputed jsdiff word diff of the tool description. Secondary to CapabilityDiff. */
export function TextDiff({ parts }: { parts: DiffPart[] }) {
  return (
    <p className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {parts.map((part, i) =>
        part.added ? (
          <ins key={i} className="bg-success/15 text-success no-underline">
            {part.value}
          </ins>
        ) : part.removed ? (
          <del key={i} className="bg-destructive/15 text-destructive">
            {part.value}
          </del>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}
    </p>
  );
}
