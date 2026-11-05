/**
 * Release notes (a CHANGELOG.md section, from the signed update manifest) as blocks the Settings
 * page renders with React elements: headings, bullet lists and paragraphs, with **bold**,
 * `code` and [links](url) inline. Never HTML: the text is shown, not parsed as markup, so nothing
 * in the notes can run or load anything. Links show their text only, since the app window
 * navigates nowhere.
 */

export type Inline = { kind: "text" | "bold" | "code"; text: string };
export type NoteBlock = { kind: "heading"; text: Inline[] } | { kind: "list"; items: Inline[][] } | { kind: "paragraph"; text: Inline[] };

/** **bold**, `code` and [text](url) (shown as text) within one line or paragraph. */
export function parseInline(source: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)\s]+\)/g;
  let at = 0;
  const text = (value: string) => {
    if (value === "") return;
    const last = parts[parts.length - 1];
    if (last?.kind === "text") last.text += value;
    else parts.push({ kind: "text", text: value });
  };
  for (const match of source.matchAll(pattern)) {
    text(source.slice(at, match.index));
    if (match[1] !== undefined) parts.push({ kind: "bold", text: match[1] });
    else if (match[2] !== undefined) parts.push({ kind: "code", text: match[2] });
    else text(match[3]!);
    at = match.index! + match[0].length;
  }
  text(source.slice(at));
  return parts;
}

/** The notes as blocks. Lines continuing a bullet or paragraph join it; blank lines end it. */
export function parseNotes(notes: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: parseInline(paragraph.join(" ")) });
    if (list.length > 0) blocks.push({ kind: "list", items: list.map(parseInline) });
    paragraph = [];
    list = [];
  };
  for (const raw of notes.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (line === "") flush();
    else if (heading) {
      flush();
      blocks.push({ kind: "heading", text: parseInline(heading[1]!) });
    } else if (bullet) {
      if (paragraph.length > 0) flush();
      list.push(bullet[1]!);
    } else if (list.length > 0) list[list.length - 1] += ` ${line}`;
    else paragraph.push(line);
  }
  flush();
  return blocks;
}
