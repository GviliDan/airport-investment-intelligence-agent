import type { ReactNode } from 'react';
import { parseBlocks } from '@/utils/markdown';

/** Inline bold, italic and code. Builds React elements (never HTML strings), so model text cannot inject markup. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key++} className="rounded bg-muted px-1 py-0.5 text-[0.92em]">{tok.slice(1, -1)}</code>);
    else out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    last = i + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-[15px] leading-relaxed [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'p') return <p key={i}>{inline(b.text)}</p>;
        if (b.kind === 'h') return <p key={i} className="pt-1 font-semibold">{inline(b.text)}</p>;
        const Tag = b.kind === 'ul' ? 'ul' : 'ol';
        return (
          <Tag key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                {inline(it.text)}
                {it.sub.length ? <ul className="mt-0.5">{it.sub.map((x, k) => <li key={k}>{inline(x)}</li>)}</ul> : null}
              </li>
            ))}
          </Tag>
        );
      })}
    </div>
  );
}
