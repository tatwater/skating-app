/**
 * D217's guard: every operator gate in the Convex functions names a capability from the map.
 *
 * Two encodings of one rule drift (the inventory found admin-only buttons drawn for moderators and
 * read queries behind the write gate). So the role literals live in exactly one place —
 * `capabilities.ts` — and this test holds the functions to it:
 *
 * - no `requireRole(…)` or `requireContributorRole(…)` call outside `lib/auth.ts`;
 * - every `requireCapability` inside an exported `mutation` names a **write** capability (the type
 *   system already holds queries to reads: a query's context only matches the read overload);
 * - every capability named exists in the map;
 * - a per-person grant (D227) is set only by the module that holds its rules, so no write skips the
 *   audit row or the last-holder check.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CAPABILITIES, type Capability, GRANTS } from './capabilities';

const CONVEX = resolve(__dirname, '../../convex/convex');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '_generated' ? [] : sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

const FILES = sources(CONVEX).map((p) => ({
  name: relative(CONVEX, p),
  text: readFileSync(p, 'utf8'),
}));

/** The exported function a position sits in, and its kind. */
function enclosing(text: string, at: number): { name: string; kind: string } | null {
  const re =
    /export const (\w+) = (query|mutation|action|internalQuery|internalMutation|internalAction)\(/g;
  let found: { name: string; kind: string } | null = null;
  for (let m = re.exec(text); m !== null && m.index < at; m = re.exec(text))
    found = { name: m[1] as string, kind: m[2] as string };
  return found;
}

describe('every operator gate names a capability (D217)', () => {
  test('the Convex sources were found', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  test('no role gate outside lib/auth.ts', () => {
    const offenders = FILES.filter((f) => f.name !== join('lib', 'auth.ts')).flatMap((f) =>
      [...f.text.matchAll(/\brequire(?:Contributor)?Role\(ctx\b/g)].map(
        (m) => `${f.name}: ${m[0]}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  const calls = FILES.flatMap((f) =>
    [...f.text.matchAll(/requireCapability\(ctx, '([^']+)'\)/g)].map((m) => ({
      file: f.name,
      capability: m[1] as string,
      fn: enclosing(f.text, m.index ?? 0),
    })),
  );

  test('the gates were found', () => {
    expect(calls.length).toBeGreaterThan(100);
  });

  test('every named capability is in the map', () => {
    expect(
      calls.filter((c) => !(c.capability in CAPABILITIES)).map((c) => `${c.file}: ${c.capability}`),
    ).toEqual([]);
  });

  test('every mutation gate names a write capability', () => {
    const wrong = calls.filter(
      (c) => c.fn?.kind === 'mutation' && !CAPABILITIES[c.capability as Capability]?.write,
    );
    expect(wrong.map((c) => `${c.file} ${c.fn?.name}: ${c.capability}`)).toEqual([]);
  });

  test('every capability in the map is used by at least one gate or is a field check', () => {
    const used = new Set(calls.map((c) => c.capability));
    const fieldChecks = new Set(
      FILES.flatMap((f) =>
        [...f.text.matchAll(/hasCapability\([^,]+, '([^']+)'\)/g)].map((m) => m[1]),
      ),
    );
    const unused = (Object.keys(CAPABILITIES) as Capability[]).filter(
      (c) => !used.has(c) && !fieldChecks.has(c),
    );
    expect(unused).toEqual([]);
  });

  test('a per-person grant is set only by its rules module (D227)', () => {
    const RULES: Record<(typeof GRANTS)[number], string> = {
      canEditLedger: join('lib', 'ledgerEditors.ts'),
    };
    for (const grant of GRANTS) {
      const setters = FILES.filter((f) =>
        new RegExp(`\\b${grant}: (true|false|undefined)\\b`).test(f.text),
      ).map((f) => f.name);
      expect(setters).toEqual([RULES[grant]]);
    }
  });
});
