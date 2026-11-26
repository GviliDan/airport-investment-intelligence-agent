/** Parses assistant text into blocks. A deliberately small Markdown subset: paragraphs, headings, lists (with nested bullets), bold and italic are handled by the renderer. */

export interface Item {
  text: string;
  /** Indented bullets under this item. */
  sub: string[];
}

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: Item[] }
  | { kind: 'ol'; items: Item[] };

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  const lastList = (): { kind: 'ul' | 'ol'; items: Item[] } | undefined => {
    const b = blocks.at(-1);
    return b && (b.kind === 'ul' || b.kind === 'ol') ? b : undefined;
  };
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const indent = /^\s*/.exec(raw)?.[0].length ?? 0;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*\u2022]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const list = lastList();
    if (line.trim() === '') flush();
    else if (heading) {
      flush();
      blocks.push({ kind: 'h', level: (heading[1] as string).length, text: heading[2] as string });
    } else if (bullet && indent >= 2 && list && para.length === 0 && list.items.length > 0) {
      // An indented bullet belongs to the list item above it.
      (list.items.at(-1) as Item).sub.push(bullet[1] as string);
    } else if (bullet || numbered) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const text = ((bullet ?? numbered) as RegExpExecArray)[1] as string;
      if (list && list.kind === kind) list.items.push({ text, sub: [] });
      else blocks.push({ kind, items: [{ text, sub: [] }] });
    } else if (indent >= 2 && list && para.length === 0) {
      // A wrapped line indented under a list item continues that item (or its last sub-bullet).
      const item = list.items.at(-1) as Item;
      if (item.sub.length > 0) item.sub[item.sub.length - 1] += ` ${line.trim()}`;
      else item.text += ` ${line.trim()}`;
    } else para.push(line.trim());
  }
  flush();
  return blocks;
}
