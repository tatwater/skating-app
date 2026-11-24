import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  groupTermsBlocks,
  isCurrentTerms,
  renderTermsMarkdown,
  splitBold,
  stripBold,
  TERMS,
  TERMS_HASHES,
  TERMS_SHA256,
  type TermsDocument,
  termsEmailBlocks,
  termsSectionHeading,
  termsVersionLabel,
} from './terms';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the committed hash', () => {
  it('is the SHA-256 of the current rendering — or the test says what to add', () => {
    const actual = sha256(renderTermsMarkdown(TERMS));
    const recorded = TERMS_HASHES[TERMS.version];
    const hint =
      recorded === undefined
        ? `A new terms version. Add this line to TERMS_HASHES in packages/core/src/legal/terms.ts:\n  '${TERMS.version}': '${actual}',`
        : `The terms' words changed but their version didn't. Set TERMS.version to today's date, then add the line this test prints to TERMS_HASHES (keep the old line).`;
    expect(recorded, hint).toBe(actual);
    expect(TERMS_SHA256).toBe(actual);
  });

  it('keeps every published version as a dated key with a 64-digit hex hash', () => {
    for (const [version, hash] of Object.entries(TERMS_HASHES)) {
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(Object.values(TERMS_HASHES)).size).toBe(Object.keys(TERMS_HASHES).length);
  });

  it('names the current terms, and nothing else, as current', () => {
    expect(isCurrentTerms({ version: TERMS.version, hash: TERMS_SHA256 })).toBe(true);
    expect(isCurrentTerms({ version: '2026-01-01', hash: TERMS_SHA256 })).toBe(false);
    expect(isCurrentTerms({ version: TERMS.version, hash: 'x'.repeat(64) })).toBe(false);
  });
});

describe('the text', () => {
  it('is ten sections, as reviewed, each with something in it', () => {
    expect(TERMS.sections).toHaveLength(10);
    expect(TERMS.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const section of TERMS.sections) {
      expect(section.heading.trim()).toBe(section.heading);
      expect(section.heading).not.toMatch(/^\d/);
      expect(section.blocks.length).toBeGreaterThan(0);
    }
  });

  it('uses only well-formed **bold** marks: every ** has a partner, no other markup', () => {
    for (const block of TERMS.sections.flatMap((s) => s.blocks)) {
      expect(stripBold(block.text)).not.toContain('*');
      expect(block.text).not.toMatch(/[<>`[\]_]/);
      expect(block.text.trim()).toBe(block.text);
    }
  });

  it('says what D294 and this build make true: 18 and over, the record, and asking again', () => {
    const all = TERMS.sections.flatMap((s) => s.blocks.map((b) => stripBold(b.text))).join(' ');
    expect(all).toContain('at least 18 years old');
    expect(all).toContain('six years after it is deleted');
    expect(all).toContain('read and accept them again');
    // The clauses the reviewed draft had dropped from the interim terms, put back.
    for (const clause of [
      'Keep your login secure',
      'right to share',
      'interfere with how it runs',
      'according to the visibility settings you choose',
      'including photos',
      'suspend or ban accounts',
      'Code of Conduct',
      'OpenStreetMap',
      'Clerk',
      'desk@teaganatwater.com',
    ]) {
      expect(all).toContain(clause);
    }
  });

  it('never says the ice is safe (D3)', () => {
    const all = TERMS.sections.flatMap((s) => s.blocks.map((b) => b.text)).join(' ');
    expect(all).not.toMatch(/\bsafe to\b|\bis safe\b(?!, and it never will)|good to go|skateable/i);
  });
});

describe('renderTermsMarkdown', () => {
  it('opens on the version, numbers each section, and lists consecutive items as one list', () => {
    const doc: TermsDocument = {
      version: '2030-01-02',
      sections: [
        { heading: 'One', blocks: [{ kind: 'p', text: 'Para **bold**.' }] },
        {
          heading: 'Two',
          blocks: [
            { kind: 'p', text: 'Lead:' },
            { kind: 'li', text: 'a' },
            { kind: 'li', text: 'b' },
            { kind: 'p', text: 'After.' },
            { kind: 'li', text: 'c' },
          ],
        },
      ],
    };
    expect(renderTermsMarkdown(doc)).toBe(
      [
        '**Version 2030-01-02**',
        '## 1. One',
        'Para **bold**.',
        '## 2. Two',
        'Lead:',
        '- a\n- b',
        'After.',
        '- c',
      ].join('\n\n'),
    );
  });

  it('is deterministic: the same document always renders the same text', () => {
    expect(renderTermsMarkdown(TERMS)).toBe(renderTermsMarkdown(structuredClone(TERMS)));
    const block = fc.record({
      kind: fc.constantFrom('p' as const, 'li' as const),
      text: fc.string(),
    });
    const doc = fc.record({
      version: fc.string(),
      sections: fc.array(fc.record({ heading: fc.string(), blocks: fc.array(block) })),
    });
    fc.assert(
      fc.property(doc, (d) => renderTermsMarkdown(d) === renderTermsMarkdown(structuredClone(d))),
    );
  });

  it('carries no trailing newline, so a file can wrap it in markers exactly', () => {
    expect(renderTermsMarkdown(TERMS).endsWith('\n')).toBe(false);
  });
});

describe('helpers for the screens and the email', () => {
  it('labels the version and numbers a heading', () => {
    expect(termsVersionLabel()).toBe(`Version ${TERMS.version}`);
    expect(termsSectionHeading(0, { heading: 'Gli', blocks: [] })).toBe('1. Gli');
  });

  it('groups blocks into runs, starting a new list after a paragraph', () => {
    expect(
      groupTermsBlocks([
        { kind: 'li', text: 'a' },
        { kind: 'li', text: 'b' },
        { kind: 'p', text: 'p' },
        { kind: 'li', text: 'c' },
      ]),
    ).toEqual([
      { kind: 'list', items: ['a', 'b'] },
      { kind: 'p', text: 'p' },
      { kind: 'list', items: ['c'] },
    ]);
  });

  it('renders the email blocks from the same source: version, then a heading per section', () => {
    const blocks = termsEmailBlocks(TERMS);
    expect(blocks[0]).toEqual({ kind: 'paragraph', text: `Version ${TERMS.version}` });
    const headings = blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
    expect(headings).toEqual(TERMS.sections.map((s, i) => termsSectionHeading(i, s)));
    expect(blocks.some((b) => b.kind === 'list')).toBe(true);
    // Every word of the markdown is in the email, and nothing else but its marks.
    const text = blocks
      .map((b) => (b.kind === 'list' ? b.items.map((i) => `- ${i}`).join('\n') : b.text))
      .join('\n\n');
    expect(text).toBe(
      renderTermsMarkdown(TERMS)
        .replace(`**Version ${TERMS.version}**`, `Version ${TERMS.version}`)
        .replace(/^## /gm, ''),
    );
  });

  it('splits bold into spans, and leaves a lone ** as text', () => {
    expect(splitBold('a **b** c **d**')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c ', bold: false },
      { text: 'd', bold: true },
    ]);
    expect(splitBold('**all**')).toEqual([{ text: 'all', bold: true }]);
    expect(splitBold('plain')).toEqual([{ text: 'plain', bold: false }]);
    expect(splitBold('')).toEqual([]);
    expect(splitBold('5 ** 2')).toEqual([{ text: '5 ** 2', bold: false }]);
  });

  it('loses no text when split: the spans join back to the stripped text', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (s) =>
          splitBold(s)
            .map((x) => x.text)
            .join('') === stripBold(s),
      ),
    );
  });
});
