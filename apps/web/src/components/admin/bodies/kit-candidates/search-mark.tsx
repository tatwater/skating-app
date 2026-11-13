import { Fragment, type ReactNode } from 'react';

/**
 * **Kit candidate** — the search highlight: the part of a name that matched what was typed, marked
 * in place (Bodies 5.3; the palette, People and Reports searches mark the same way). The design
 * thread's rule: the ice mark ground (`acc-mark`) with a 1 px ice underline, the text keeping its
 * own ink — never bold, never a color change.
 *
 * Matching is the reader's, not the server's: case- and accent-insensitive, every occurrence of the
 * whole typed text (not its words — "mor" marks "Mor" in "Lake Morey", not every "m"). Blank marks
 * nothing.
 */

/** Strips accents and case so "Memphrémagog" matches "memphremagog". Keeps the length per char. */
function fold(text: string): string {
  return [...text]
    .map((c) => c.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase())
    .join('');
}

/** `text` cut where `query` matches: alternating plain and matched parts, plain first. */
function matchParts(text: string, query: string): { text: string; match: boolean }[] {
  const needle = fold(query.trim());
  if (needle === '') return [{ text, match: false }];
  const chars = [...text];
  const folded = chars.map((c) => fold(c));
  const parts: { text: string; match: boolean }[] = [];
  let plain = '';
  let i = 0;
  while (i < chars.length) {
    // Grow a window of folded characters until it covers the needle's length.
    let j = i;
    let window = '';
    while (j < chars.length && window.length < needle.length) window += folded[j++];
    if (window === needle) {
      if (plain !== '') parts.push({ text: plain, match: false });
      parts.push({ text: chars.slice(i, j).join(''), match: true });
      plain = '';
      i = j;
    } else {
      plain += chars[i];
      i += 1;
    }
  }
  if (plain !== '' || parts.length === 0) parts.push({ text: plain, match: false });
  return parts;
}

type SearchMarkProps = {
  /** The text to draw. */
  text: string;
  /** What was typed. */
  query: string;
};

function SearchMark({ text, query }: SearchMarkProps): ReactNode {
  const parts = matchParts(text, query);
  return parts.map((part, i) =>
    part.match ? (
      <mark
        // Parts are positional: the i-th run of the text.
        // biome-ignore lint/suspicious/noArrayIndexKey: a run is its index
        key={i}
        data-slot="search-mark"
        className="bg-acc-mark px-px text-inherit shadow-[0_var(--stroke-hair)_0_var(--acc)]"
      >
        {part.text}
      </mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: a run is its index
      <Fragment key={i}>{part.text}</Fragment>
    ),
  );
}

export { matchParts, SearchMark, type SearchMarkProps };
