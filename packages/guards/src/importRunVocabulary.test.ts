/**
 * **The run vocabulary is said twice, and the two must agree** (B01-6a). `importRuns.kind` and
 * `importRuns.scope.pass` are validated by `IMPORT_RUN_KINDS` and `IMPORT_RUN_SCOPES` in the Convex
 * package, and re-declared as `ImportRunKind` and `ImportRunScopePass` in `@skating/run-log` — on
 * purpose, so a loader compiles without `_generated` (see `scripts/run-log/src/types.ts`). A member
 * on one side only is a loader that type-checks and is refused by the deployment, or a validator
 * member no loader can send; neither shows until a campaign is running.
 *
 * Read off disk, so it lives here (D236): the two files are in two packages.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const ENUMS = readFileSync(resolve(REPO, 'packages/convex/convex/lib/enums.ts'), 'utf8');
const TYPES = readFileSync(resolve(REPO, 'scripts/run-log/src/types.ts'), 'utf8');

/**
 * The string members of a declaration, read line by line from its first line: comment lines are
 * skipped (a doc comment may hold a `;` or a quoted word), and the first code line ending in `;`
 * closes it.
 */
function declarationMembers(source: string, opener: string, file: string): string[] {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => l.startsWith(opener));
  if (at === -1) throw new Error(`${opener} not found in ${file}`);
  const found: string[] = [];
  for (const raw of lines.slice(at)) {
    const line = raw.trim();
    if (line.startsWith('/*') || line.startsWith('*') || line.startsWith('//')) continue;
    const code = line.replace(/\/\/.*$/, '');
    for (const m of code.matchAll(/'([^']+)'/g)) found.push(m[1] as string);
    if (code.endsWith(';')) break;
  }
  return found.sort();
}

const constMembers = (name: string) =>
  declarationMembers(ENUMS, `export const ${name} = [`, 'enums.ts');
const unionMembers = (name: string) =>
  declarationMembers(TYPES, `export type ${name} =`, "run-log's types.ts");

test('every run kind the deployment accepts is one a loader can name, and no other', () => {
  const kinds = constMembers('IMPORT_RUN_KINDS');
  expect(kinds.length).toBeGreaterThan(20);
  expect(unionMembers('ImportRunKind')).toEqual(kinds);
});

test('every scope pass the deployment accepts is one a loader can name, and no other', () => {
  const passes = constMembers('IMPORT_RUN_SCOPES');
  expect(passes).toContain('full-canonical');
  expect(unionMembers('ImportRunScopePass')).toEqual(passes);
});
