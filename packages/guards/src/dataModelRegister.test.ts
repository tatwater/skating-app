/**
 * `plans/06-data-model.md` is the map over `schema.ts`: one line per table, the vocabulary's
 * provenance, and the rules that bite. It drifted to 25 missing tables the first time because
 * nothing checked it. This test does: every `defineTable` in the schema has a row in the map, and
 * every key in the core vocabulary constants is mentioned there.
 *
 * It checks presence, not prose — a table is "in the map" when its name appears in a code span.
 *
 * Lives in `@skating/guards`, not `@skating/core`: it reads the repo off disk, which no Turbo
 * input glob can describe, so it belongs to an uncached task that always runs (D236, see the
 * package README). Moving it into a cached package makes its green meaningless.
 *
 * The vocabulary comes in from core's four source modules by path, not from the `@skating/core`
 * barrel. The barrel re-exports ~160 modules and pulls `@turf/*` to deliver twenty string arrays,
 * and because this task is never cached that transform is paid on *every* `pnpm test`: measured
 * here, 3.03 s for the package with the barrel (72% of it transform) against 0.33 s with the four
 * modules. In `packages/core` the barrel was free, since core's own suite had already transformed
 * those modules; moving the file made it a new and permanent cost.
 *
 * Reaching across the package boundary is deliberate and narrow. This package is the one that is
 * *about* the repo's layout — two lines below, it reads `packages/convex/convex/schema.ts` off
 * disk by path — so a path into `packages/core/src` is the same kind of access, not a new
 * liberty. `@skating/core` stays a declared dependency so the relationship is visible, and core's
 * `exports` map is left alone rather than widened for a test's benefit.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ACCESS_ALERT_REASONS, ACCESS_CONDITION_REASONS } from '../../core/src/accessAlert';
import { STANDINGS } from '../../core/src/standing';
import {
  HAZARD_TYPES,
  ICE_TYPES,
  OBSERVED_FROM,
  SECTORS,
  SIGHTINGS,
  SKATE_END_PRECISIONS,
  SKATE_QUALITIES,
  SNOW_COVERAGES,
  SNOW_DRIFTS,
  SNOW_IMPEDIMENTS,
  SUITABILITIES,
  SURFACE_TAGS,
  THICKNESS_METHODS,
  THICKNESS_SCOPES,
  WATER_BODY_CLASSES,
  WHERE_EXTENTS,
} from '../../core/src/types';
import { WHERE_KINDS } from '../../core/src/where';

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
      ...THICKNESS_SCOPES,
      ...STANDINGS,
      // A10 (D189–D197): the sheet's vocabulary.
      ...SUITABILITIES,
      ...OBSERVED_FROM,
      ...SIGHTINGS,
      ...SKATE_END_PRECISIONS,
      ...SNOW_COVERAGES,
      ...SNOW_IMPEDIMENTS,
      ...SNOW_DRIFTS,
      ...WHERE_EXTENTS,
      ...SECTORS,
      ...WHERE_KINDS,
      ...ACCESS_CONDITION_REASONS,
      ...ACCESS_ALERT_REASONS,
    ];
    const vocabulary = namedIn(section('## Vocabulary', '## Derived, not stored'));
    const missing = keys.filter((k) => !vocabulary.has(k));
    expect(missing, 'add the key to plans/06-data-model.md § Vocabulary').toEqual([]);
  });
});
