import { describe, expect, it } from "vitest";
import { parseInline, parseNotes } from "../../web/src/lib/notes.js";

describe("release notes", () => {
  it("turns a changelog section into headings, lists and paragraphs", () => {
    const notes = "Intro line\ncontinued.\n\n### Added\n- **OpenCode** is supported: `latch setup`\n  wraps it.\n- Second.\n\n### Fixed\n- Third.";
    expect(parseNotes(notes)).toEqual([
      { kind: "paragraph", text: [{ kind: "text", text: "Intro line continued." }] },
      { kind: "heading", text: [{ kind: "text", text: "Added" }] },
      {
        kind: "list",
        items: [
          [{ kind: "bold", text: "OpenCode" }, { kind: "text", text: " is supported: " }, { kind: "code", text: "latch setup" }, { kind: "text", text: " wraps it." }],
          [{ kind: "text", text: "Second." }],
        ],
      },
      { kind: "heading", text: [{ kind: "text", text: "Fixed" }] },
      { kind: "list", items: [[{ kind: "text", text: "Third." }]] },
    ]);
  });

  it("shows a link's text only, and markup-looking text as text", () => {
    expect(parseInline("see [INSTALL.md](https://example.com/x) and <img src=x>")).toEqual([{ kind: "text", text: "see INSTALL.md and <img src=x>" }]);
  });
});
