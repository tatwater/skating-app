/**
 * **A console field takes the server's cap from the one definition** (B01-3o). Every text field in
 * the Body console, the Bodies library and the shell that a write sends to a capped server field
 * carries `maxLength` set to that cap — an identifier imported from `@skating/core` and defined in
 * `textCaps.ts` (or the audit log's `AUDIT_REASON_MAX`, D261), never a copied number — so an
 * operator can't type past what the server refuses. A field with no capped write behind it is in the
 * list below with why; a component that hands its field the cap as a prop (`ReasonAsk`) is held at
 * each place it is used instead.
 *
 * A lint over the source text, not a proof: each field's own test shows the attribute rendered.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const WEB = resolve(__dirname, '../../../apps/web/src');
const CORE = resolve(__dirname, '../../core/src');

/** The console's trees the rule holds over. People's pages are their owner's (see below). */
const ROOTS = [
  'components/admin/body',
  'components/admin/bodies',
  'components/admin/shell',
  'components/admin/inbox',
];

/** The text fields: the kit's, and a bare element. */
const FIELDS = ['Input', 'ChipInput', 'AlertDialogReason', 'Textarea', 'textarea', 'input'];

/** Components that take the cap as a prop and give it to their field; each use is held instead. */
const PASS_THROUGH: Record<string, string> = {
  ReasonAsk: 'components/admin/body/tabs/access/ReasonAsk.tsx',
  // The ticket's reply and note field (B01-5f): each mode hands it its cap (`max`).
  ReplyDock: 'components/kit/reply-dock.tsx',
};

/**
 * Pass-throughs whose caps ride in another prop than `maxLength` — `ReplyDock`'s modes, each with
 * its own `max:` — held at each use by every such `max:` in the using file being a shared cap
 * imported from core (and at least one there).
 */
const CAPS_IN: Record<string, RegExp> = { ReplyDock: /\bmax:\s*(\w+)/g };

/**
 * Fields no capped write receives, each with why. Keyed `file :: label` (the field's
 * `aria-label`, or `#n` for the file's nth field).
 */
const NO_CAPPED_WRITE: Record<string, string> = {
  'components/admin/body/tabs/water/WaterView.tsx :: A survey the next build should load':
    'no write yet: what a filing records is the founder’s call, and the field is drawn disabled',
  'components/admin/body/tabs/imagery/ImageryTabView.tsx :: #1':
    'no write yet: the pass override is drawn Not available yet until the apps honor it',
  'components/admin/body/tabs/shape/MergeFlow.tsx :: #1':
    'a search for the body to merge into: a read, and the server never refuses its length',
  'components/admin/bodies/ListTools.tsx :: Find a body':
    'a search: the server cuts a long one to its length, never refuses it',
  'components/admin/body/tabs/shape/BayTask.tsx :: #2':
    'a bay’s other spellings, comma-separated: the server holds each one to the name’s cap and says so; the field’s own length is no write’s',
  'components/admin/body/tabs/shape/BayTask.tsx :: #3':
    'a pasted GeoJSON shape: parsed here, and the write is a geometry, never this text',
  'components/admin/inbox/list/LaneFacets.tsx :: #1':
    'the filter menu’s search for a body or a person: a read, never refused for its length',
};

function files(path: string): string[] {
  const full = join(WEB, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)],
  );
}
const NOT_CODE = /\.(test|stories)\.tsx?$|Fixtures\.ts$/;

/**
 * The source without its comments — a doc comment's `<input>` is no field, and an apostrophe in a
 * comment inside a tag would read as a quote. A `//` after a colon or a quote (a URL) is kept.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

/** The opening tag that starts at `from`, to its closing `>` (braces and strings skipped). */
function openingTag(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return text.slice(from, i + 1);
  }
  throw new Error(`An unclosed tag at ${from}`);
}

/** The names a file imports from `@skating/core`. */
function coreImports(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'@skating\/core'/g)) {
    for (const part of (m[1] as string).split(',')) {
      const name = part.replace(/^\s*type\s+/, '').trim();
      if (name !== '') names.add(name);
    }
  }
  return names;
}

/** The caps a field may take: every `export const MAX_…` in textCaps, and the audit cap. */
function shared(): Set<string> {
  const text = readFileSync(join(CORE, 'textCaps.ts'), 'utf8');
  const caps = new Set(
    [...text.matchAll(/export const (MAX_\w+)\s*=/g)].map((m) => m[1] as string),
  );
  caps.add('AUDIT_REASON_MAX');
  return caps;
}

type Field = { where: string; tag: string; label: string; cap: string | null };

/** Every text field (and use of a pass-through component) in the console's trees. */
function fields(): Field[] {
  const out: Field[] = [];
  const tags = new RegExp(`<(${[...FIELDS, ...Object.keys(PASS_THROUGH)].join('|')})\\b`, 'g');
  for (const f of ROOTS.flatMap(files).filter((p) => /\.tsx$/.test(p) && !NOT_CODE.test(p))) {
    const text = code(readFileSync(join(WEB, f), 'utf8'));
    let n = 0;
    for (const m of text.matchAll(tags)) {
      const tag = openingTag(text, m.index as number);
      const name = m[1] as string;
      // A checkbox, a radio, a file: not text.
      if (/\btype="(checkbox|radio|file|range|hidden)"/.test(tag)) continue;
      n++;
      const label = /aria-label="([^"]*)"/.exec(tag)?.[1] ?? `#${n}`;
      const inProp = CAPS_IN[name];
      if (inProp !== undefined) {
        // Every cap the file hands this component's modes, each a field of its own to check.
        const handed = [...text.matchAll(inProp)].map((c) => c[1] as string);
        if (handed.length === 0)
          out.push({ where: `${f} :: ${label}`, tag: name, label, cap: null });
        for (const cap of handed)
          out.push({ where: `${f} :: ${label} (${cap})`, tag: name, label, cap });
        continue;
      }
      const cap = /\bmaxLength=\{(\w+)\}/.exec(tag)?.[1] ?? null;
      out.push({ where: `${f} :: ${label}`, tag: name, label, cap });
    }
  }
  return out;
}

test('every console text field a capped write receives takes the shared cap', () => {
  const caps = shared();
  const passing = new Set(Object.values(PASS_THROUGH));
  // A floor: the walk saw the fields it guards (a regex that matched nothing would pass anything).
  const all = fields();
  expect(all.length).toBeGreaterThanOrEqual(15);
  const wrong: string[] = [];
  for (const field of all) {
    if (NO_CAPPED_WRITE[field.where] !== undefined) continue;
    const file = field.where.split(' :: ')[0] as string;
    const text = readFileSync(join(WEB, file), 'utf8');
    // A pass-through component's own field forwards the prop it was given; its uses are held.
    if (passing.has(file) && field.cap === 'maxLength') continue;
    if (field.cap === null) wrong.push(`${field.where}: no maxLength`);
    else if (!caps.has(field.cap)) wrong.push(`${field.where}: ${field.cap} isn’t a shared cap`);
    else if (!coreImports(text).has(field.cap)) {
      wrong.push(`${field.where}: ${field.cap} isn’t imported from @skating/core`);
    }
  }
  expect(wrong).toEqual([]);
});

test('an exemption names a field that is still there', () => {
  const seen = new Set(fields().map((f) => f.where));
  expect(Object.keys(NO_CAPPED_WRITE).filter((k) => !seen.has(k))).toEqual([]);
});

test('no console file caps a field with a copied number', () => {
  const copied = ROOTS.flatMap(files)
    .filter((p) => /\.tsx?$/.test(p) && !NOT_CODE.test(p))
    .filter((p) => /\bmaxLength=\{\s*\d/.test(readFileSync(join(WEB, p), 'utf8')));
  expect(copied).toEqual([]);
});
