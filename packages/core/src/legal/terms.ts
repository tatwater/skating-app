/**
 * **The Terms of Use, as data** (D295). The one source of the words a skater reads to the end and
 * accepts, in both apps, in the emailed copy, and in `TERMS.md` — whose body between its markers is
 * `renderTermsMarkdown(TERMS)` exactly, held there by `packages/guards/src/termsDocument.test.ts`.
 *
 * **To change the terms:** edit the words below, set `version` to today's date (`YYYY-MM-DD`; the
 * season card reads it as "Unchanged since …"), then run core's tests. `terms.test.ts` fails and
 * prints one line, `'<version>': '<sha256>'` — add it to `TERMS_HASHES` (never edit an old line;
 * each is a version that skaters accepted, and the records name it). Then regenerate `TERMS.md`'s
 * body: the guard's failure shows the text to paste between the markers. **Every new version asks
 * every skater to read and accept the terms again at their next sign-in** (section 9 says so), so
 * a typo fix is a new version too: the hash is what a record proves was accepted.
 *
 * Inline markup is `**bold**` and nothing else — the email renderer's convention
 * (`packages/convex/convex/lib/emailBlocks.ts`), so the same text renders in an app, an email and a
 * markdown file without any of them inventing a syntax the others can't read. A block is a
 * paragraph (`p`) or a list item (`li`); consecutive items make one list.
 */

import { ledgerHash } from './hashLedger';

export interface TermsBlock {
  kind: 'p' | 'li';
  text: string;
}

export interface TermsSection {
  /** The heading without its number: the number is the section's place, `termsSectionHeading`. */
  heading: string;
  blocks: readonly TermsBlock[];
}

export interface TermsDocument {
  /** The date this text was written, `YYYY-MM-DD`. */
  version: string;
  sections: readonly TermsSection[];
}

const p = (text: string): TermsBlock => ({ kind: 'p', text });
const li = (text: string): TermsBlock => ({ kind: 'li', text });

export const TERMS: TermsDocument = {
  version: '2026-11-24',
  sections: [
    {
      heading: 'Gli is not a safety authority',
      blocks: [
        p(
          'Gli helps skaters share what they saw on the ice. **It does not tell you whether ice is safe, and it never will.**',
        ),
        p(
          'Every report is one named person’s observation at a specific time and place. It is not a guarantee, a prediction, or a recommendation to go onto any ice.',
        ),
        p(
          'Ice changes quickly and unpredictably. Information in the app may be outdated, incomplete, mistaken, or wrong.',
        ),
      ],
    },
    {
      heading: 'Assumption of risk',
      blocks: [
        p(
          'Skating on wild ice is inherently dangerous and can result in serious injury or death. You understand and accept those risks, and the risks of related activities.',
        ),
        p(
          '**You alone decide where and whether to skate, and you do so at your own risk.** To the fullest extent permitted by law, the operator is not liable for any injury, loss, or damage arising from your use of the app or from anything shared through it.',
        ),
      ],
    },
    {
      heading: 'Eligibility',
      blocks: [
        p(
          'You must be **at least 18 years old** to use Gli. By creating an account, you confirm that you are.',
        ),
      ],
    },
    {
      heading: 'Your account and conduct',
      blocks: [
        p('Keep your login secure. You’re responsible for what happens on your account.'),
        p(
          'Post honestly. A knowingly false ice report, especially a dangerously false “the ice is great” report, is a safety violation, not a prank, and may result in removal and a ban.',
        ),
        p(
          'Don’t harass, impersonate, spam, or post anyone’s private information. Follow Gli’s Code of Conduct.',
        ),
        p(
          'Don’t post anything you don’t have the right to share, and don’t misuse the app’s data or interfere with how it runs.',
        ),
      ],
    },
    {
      heading: 'Your content',
      blocks: [
        p(
          'You keep ownership of what you post. You grant the operator a license to store, display, and share it within the app, according to the visibility settings you choose.',
        ),
        p(
          'You’re responsible for what you post, including photos, and you confirm you have the right to post it.',
        ),
        p(
          'The operator may remove content, and suspend or ban accounts, that break these terms or the Code of Conduct.',
        ),
      ],
    },
    {
      heading: 'Third-party services',
      blocks: [
        p(
          'Maps, imagery, routing, weather, and sign-in come from other services, each governed by its own terms and privacy policy, which also apply to your use of them. Gli uses:',
        ),
        li(
          'Maps and imagery: OpenStreetMap contributors, Protomaps, USGS, and Copernicus Sentinel data.',
        ),
        li('Routing: OpenRouteService.'),
        li('Address search: Geoapify.'),
        li('Weather: Open-Meteo and the National Weather Service.'),
        li('Sign-in: Clerk.'),
        li('Email and push delivery: Resend, Expo, Apple, and Google.'),
        li('Strava, only if you connect it, and Google Photos, only when you pick photos from it.'),
      ],
    },
    {
      heading: 'Privacy',
      blocks: [
        p(
          'The Privacy Notice explains what Gli stores about you, including the record of this acceptance, and how long it is kept.',
        ),
        p(
          'That record holds your name, email, and date of birth as you gave them, which version of these terms you accepted and when, the IP address your sign-in was using, and the kind of device you used. Each time you answer Know Before You Go, Gli keeps a record of that too.',
        ),
        p(
          'These records are never public. They are kept while your account exists and for six years after it is deleted, and then deleted automatically.',
        ),
      ],
    },
    {
      heading: 'No warranty',
      blocks: [
        p(
          'The app is provided **“as is,” without warranties of any kind**, to the fullest extent permitted by law. We don’t guarantee it will be accurate, available, or error-free.',
        ),
      ],
    },
    {
      heading: 'Changes',
      blocks: [
        p(
          'These are interim terms for Gli’s early days, and a full agreement will replace them before any wider launch.',
        ),
        p('When these terms change, Gli asks you to read and accept them again before you go on.'),
      ],
    },
    {
      heading: 'Contact',
      blocks: [
        p(
          'Questions about these terms go to Contact Support, in Settings, or to **desk@teaganatwater.com**.',
        ),
      ],
    },
  ],
};

/**
 * Every version skaters have been asked to accept, with the SHA-256 of its rendering
 * (`renderTermsMarkdown`, UTF-8, hex). Append only: a record names its version and hash, so an old
 * line is the key to reading an old record. `terms.test.ts` recomputes the current one and fails
 * with the line to add when the words change; it also fails when the words change under a version
 * that is already here, which is the forgotten bump.
 */
export const TERMS_HASHES: Readonly<Record<string, string>> = {
  '2026-11-24': 'dba06b83fd70e1b8376fc420df5b3a623d4bd9c6dc6f9dbd990f3e9e420e3010',
};

/**
 * The current terms' SHA-256: what a client sends with an acceptance and a record stores. It is the
 * hash of the markdown rendering, so anyone can check a record against `TERMS.md` as it stood: the
 * text between its markers hashes to this.
 */
export const TERMS_SHA256: string = ledgerHash(TERMS_HASHES, TERMS.version);

/** Whether a client's `{ version, hash }` names the terms this build serves. */
export function isCurrentTerms(claim: { version: string; hash: string }): boolean {
  return claim.version === TERMS.version && claim.hash === TERMS_SHA256;
}

/** "Version 2026-11-24" — the reader's meta line and the document's first line. */
export function termsVersionLabel(terms: TermsDocument = TERMS): string {
  return `Version ${terms.version}`;
}

/** "1. Gli is not a safety authority" — a section's heading with its number. */
export function termsSectionHeading(index: number, section: TermsSection): string {
  return `${index + 1}. ${section.heading}`;
}

/** A section's blocks as runs: each paragraph alone, consecutive list items as one list. */
export type TermsRun = { kind: 'p'; text: string } | { kind: 'list'; items: string[] };

export function groupTermsBlocks(blocks: readonly TermsBlock[]): TermsRun[] {
  const runs: TermsRun[] = [];
  for (const block of blocks) {
    const last = runs[runs.length - 1];
    if (block.kind === 'p') runs.push({ kind: 'p', text: block.text });
    else if (last?.kind === 'list') last.items.push(block.text);
    else runs.push({ kind: 'list', items: [block.text] });
  }
  return runs;
}

/** The terms as markdown: the version line, then each numbered section. No trailing newline. */
export function renderTermsMarkdown(terms: TermsDocument): string {
  const parts = [`**${termsVersionLabel(terms)}**`];
  terms.sections.forEach((section, i) => {
    parts.push(`## ${termsSectionHeading(i, section)}`);
    for (const run of groupTermsBlocks(section.blocks)) {
      parts.push(run.kind === 'p' ? run.text : run.items.map((item) => `- ${item}`).join('\n'));
    }
  });
  return parts.join('\n\n');
}

/**
 * The terms as the email renderer's blocks (`lib/emailBlocks`' `EmailBlock`, structurally): the
 * version line, then a heading per section and its paragraphs and lists. Times are never part of
 * it (D295: the stamps are evidence, not interface).
 */
export type TermsEmailBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

export function termsEmailBlocks(terms: TermsDocument): TermsEmailBlock[] {
  const blocks: TermsEmailBlock[] = [{ kind: 'paragraph', text: termsVersionLabel(terms) }];
  terms.sections.forEach((section, i) => {
    blocks.push({ kind: 'heading', text: termsSectionHeading(i, section) });
    for (const run of groupTermsBlocks(section.blocks)) {
      blocks.push(run.kind === 'p' ? { kind: 'paragraph', text: run.text } : run);
    }
  });
  return blocks;
}

/** A piece of inline text, bold or not — what a screen renders as a `<strong>` or a plain span. */
export interface InlineSpan {
  text: string;
  bold: boolean;
}

/**
 * `**bold**` split into spans for a screen. The same pattern the email renderer matches, so a span is
 * bold here exactly when it is bold in the email; a stray `**` with no partner stays literal text.
 */
export function splitBold(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > at) spans.push({ text: text.slice(at, start), bold: false });
    spans.push({ text: match[1] as string, bold: true });
    at = start + match[0].length;
  }
  if (at < text.length) spans.push({ text: text.slice(at), bold: false });
  return spans;
}

/** The text with its bold marks dropped — for a plain-text surface (an accessibility label, a log). */
export function stripBold(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1');
}
