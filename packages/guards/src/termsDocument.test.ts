/**
 * **The terms a skater accepts in the app are the terms in `TERMS.md`, and the Privacy Notice their
 * acceptance pins is `PRIVACY.md` as it stands** (D295, B03 §9.12).
 *
 * The terms are data in core (`packages/core/src/legal/terms.ts`), versioned and hashed, and a record
 * stores the version and the hash. `TERMS.md`'s body, between its two markers, is
 * `renderTermsMarkdown(TERMS)` exactly — so the hash a record holds is the hash of that text in the
 * file at the version it names, and the file and the app can never say different things.
 *
 * The notice is not data: the agree line links to it and never gates it on a scroll, so `PRIVACY.md`
 * is the text. Core pins its *Last updated* date and the file's SHA-256 so a record can say which
 * notice was current; this holds the pin to the file, so editing the notice without updating the
 * pin fails here with the values to paste.
 *
 * In `@skating/guards`: it reads files at the repo root, which no Turbo input glob of core's own test
 * task would hash (D236).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PRIVACY_NOTICE_SHA256,
  PRIVACY_NOTICE_VERSION,
  renderTermsMarkdown,
  TERMS,
  TERMS_SHA256,
} from '@skating/core';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(resolve(REPO, file), 'utf8');
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The markers' own lines: everything between them is generated. */
const BEGIN = /^<!-- terms:begin\b.*-->\n/m;
const END = /\n<!-- terms:end -->$/m;

/** The text between `TERMS.md`'s markers. */
function termsBody(markdown: string): string {
  const begin = BEGIN.exec(markdown);
  const end = END.exec(markdown);
  if (!begin || !end || end.index < begin.index) {
    throw new Error('TERMS.md lost its <!-- terms:begin … --> / <!-- terms:end --> markers');
  }
  return markdown.slice(begin.index + begin[0].length, end.index);
}

describe('TERMS.md', () => {
  const terms = read('TERMS.md');

  it('holds core’s terms between its markers, exactly', () => {
    expect(
      termsBody(terms),
      'TERMS.md is out of step with packages/core/src/legal/terms.ts. Replace everything between its markers with renderTermsMarkdown(TERMS) — the expected side of this diff.',
    ).toBe(renderTermsMarkdown(TERMS));
  });

  it('hashes, between its markers, to the hash a record stores', () => {
    expect(sha256(termsBody(terms))).toBe(TERMS_SHA256);
  });

  it('has one pair of markers', () => {
    expect(terms.match(/<!-- terms:begin/g)).toHaveLength(1);
    expect(terms.match(/<!-- terms:end -->/g)).toHaveLength(1);
  });
});

describe('PRIVACY.md', () => {
  const privacy = read('PRIVACY.md');

  it('is the notice core pins: its Last updated date and its SHA-256', () => {
    const lastUpdated = /^\*\*Last updated: (\d{4}-\d{2}-\d{2})\*\*$/m.exec(privacy)?.[1];
    const actual = { version: lastUpdated, sha256: sha256(privacy) };
    expect(
      actual,
      `PRIVACY.md changed. Set its Last updated line to today, then set PRIVACY_NOTICE_VERSION and PRIVACY_NOTICE_SHA256 in packages/core/src/legal/privacyNotice.ts to the received values here (the hash after the date is updated).`,
    ).toEqual({ version: PRIVACY_NOTICE_VERSION, sha256: PRIVACY_NOTICE_SHA256 });
  });
});

describe('termsBody', () => {
  it('reads between the markers, and refuses a file without them', () => {
    expect(termsBody('a\n<!-- terms:begin x -->\nbody\nmore\n<!-- terms:end -->\nb')).toBe(
      'body\nmore',
    );
    expect(() => termsBody('no markers')).toThrow(/markers/);
    expect(() => termsBody('<!-- terms:end -->\n<!-- terms:begin -->\n')).toThrow(/markers/);
  });
});
