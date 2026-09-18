/**
 * `plans/06-data-model.md` is the map over `schema.ts`: one line per table, the vocabulary's
 * provenance, and the rules that bite. It drifted to 25 missing tables the first time because
 * nothing checked it. This test does: every `defineTable` in the schema has a row in the map, and
 * every key in the core vocabulary constants is mentioned there.
 *
 * It checks presence, not prose — a table is "in the map" when its name appears in a code span.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { STANDINGS } from './standing';
import {
  HAZARD_TYPES,
  ICE_TYPES,
  SKATE_QUALITIES,
  SURFACE_TAGS,
  THICKNESS_METHODS,
  WATER_BODY_CLASSES,
} from './types';

const REPO = resolve(__dirname, '../../..');
const MAP = readFileSync(join(REPO, 'plans/06-data-model.md'), 'utf8');
const SCHEMA = readFileSync(join(REPO, 'packages/convex/convex/schema.ts'), 'utf8');

/**
 * Only the section that's *for* the thing counts: a table mentioned in passing under "Relationships"
 * or "Rules that bite" is not a map row, and a vocabulary key quoted in a rule is not the vocabulary.
 */
function section(heading: string, next: string): string {
  const start = MAP.indexOf(heading);
  expect(start, `06 has lost its "${heading}" heading`).toBeGreaterThan(-1);
  const end = MAP.indexOf(next, start + heading.length);
  return MAP.slice(start, end === -1 ? undefined : end);
}

/** The code spans of a section. A span may name several tables (`a` · `b`); split on separators. */
function namedIn(text: string): Set<string> {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
  return new Set(spans.flatMap((s) => s.split(/\s*[·,/]\s*/)));
}

/** The map's table rows, first cell only — `| \`name\` | for … |` — so prose in a row's "for" cell can't count. */
function mapRows(): Set<string> {
  const rows = [
    ...section('## The map', '## Relationships').matchAll(/^\| ((?:`[^`]+`(?:\s*·\s*)?)+) \|/gm),
  ];
  return namedIn(rows.map((m) => m[1] as string).join('\n'));
}

describe('the data-model map matches the schema', () => {
  test('every table defined in schema.ts has a row', () => {
    // `\w+`, not `[a-zA-Z]+`: a table with a digit in its name must not slip past the count guard.
    const tables = [...SCHEMA.matchAll(/^ {2}(\w+): defineTable/gm)].map((m) => m[1] as string);
    expect(tables.length).toBeGreaterThan(40);
    const rows = mapRows();
    expect(rows.size).toBeGreaterThan(40);
    const missing = tables.filter((t) => !rows.has(t));
    expect(missing, 'add a row to plans/06-data-model.md § The map').toEqual([]);
  });

  test('every vocabulary key is mentioned', () => {
    const keys = [
      ...ICE_TYPES,
      ...SURFACE_TAGS,
      ...HAZARD_TYPES,
      ...WATER_BODY_CLASSES,
      ...SKATE_QUALITIES,
      ...THICKNESS_METHODS,
      ...STANDINGS,
    ];
    const vocabulary = namedIn(section('## Vocabulary', '## Derived, not stored'));
    const missing = keys.filter((k) => !vocabulary.has(k));
    expect(missing, 'add the key to plans/06-data-model.md § Vocabulary').toEqual([]);
  });
});
