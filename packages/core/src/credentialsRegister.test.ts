/**
 * `plans/05-accounts-and-credentials.md` § 2 is the register of every environment variable the
 * project reads, by where it lives. It went stale the first time because nothing checked it — an env
 * var is added where the code needs it and the doc is three directories away. This test closes that
 * loop: collect every name the backend, the pipelines and the two clients actually read — plus
 * every name an `.env.example` documents, which is how the pipelines' shell wrappers declare
 * theirs — and fail if one is missing from the register.
 *
 * Names are what's checked, never values. A name that is read but deliberately unregistered does
 * not exist — register it as a knob, a secret, or a Convex-provided builtin; the register has a row
 * for each kind.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO = resolve(__dirname, '../../..');
const REGISTER = join(REPO, 'plans/05-accounts-and-credentials.md');

const PROCESS_ENV = /process\.env\.([A-Z][A-Z0-9_]+)/g;
const IMPORT_META_ENV = /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g;

/** A tree of sources filtered by relative path, or one known file. */
type Source = { pattern: RegExp } & ({ dir: string; ext: RegExp } | { file: string });

/** Source trees whose env reads must be registered, with the read pattern each one uses. */
const SOURCES: Source[] = [
  // Convex functions and the shared libs under them: `process.env.NAME`.
  { dir: 'packages/convex/convex', pattern: PROCESS_ENV, ext: /\.tsx?$/ },
  // Pipelines: the same, in each package's src/ (READMEs and shell wrappers are prose, not reads).
  { dir: 'scripts', pattern: PROCESS_ENV, ext: /\/src\/[^/]+\.tsx?$/ },
  // Mobile: Metro inlines `process.env.EXPO_PUBLIC_*`; app.config.ts reads build-time vars.
  { dir: 'apps/mobile/src', pattern: PROCESS_ENV, ext: /\.tsx?$/ },
  { dir: 'apps/mobile/app', pattern: PROCESS_ENV, ext: /\.tsx?$/ },
  { file: 'apps/mobile/app.config.ts', pattern: PROCESS_ENV },
  // Web: Vite exposes `import.meta.env.VITE_*`; vite.config reads build-time `process.env`.
  { dir: 'apps/web/src', pattern: IMPORT_META_ENV, ext: /\.tsx?$/ },
  { file: 'apps/web/vite.config.ts', pattern: PROCESS_ENV },
];

/**
 * The example files document names — the two clients' and each pipeline's (whose shell wrappers
 * read them, which the source scan above can't see). They must agree with the register too.
 */
const EXAMPLES = [
  'apps/web/.env.example',
  'apps/mobile/.env.example',
  ...readdirSync(join(REPO, 'scripts'))
    .map((name) => `scripts/${name}/.env.example`)
    .filter((rel) => existsSync(join(REPO, rel))),
];

/** The one example file a client-side name belongs in, by prefix. */
function ownExample(name: string): string | null {
  if (name.startsWith('VITE_')) return 'apps/web/.env.example';
  if (name.startsWith('EXPO_PUBLIC_')) return 'apps/mobile/.env.example';
  return null;
}

/**
 * Names that are not configuration: Node's own, Vite's own, and the mobile file's `EXPO_PUBLIC_`
 * prefix read as a bare token by a comment-scanning regex. Nothing project-specific goes here —
 * a project variable belongs in the register, not in an exemption.
 */
const NOT_CONFIG = new Set(['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'EXPO_PUBLIC_']);

function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '_generated' || name.startsWith('.')) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

function filesOf(source: Source): string[] {
  if ('file' in source) return [join(REPO, source.file)];
  const root = join(REPO, source.dir);
  return walk(root).filter((f) => source.ext.test(relative(root, f)));
}

function namesRead(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const source of SOURCES) {
    const { pattern } = source;
    for (const file of filesOf(source)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(pattern)) {
        const name = m[1] as string;
        if (NOT_CONFIG.has(name)) continue;
        const where = found.get(name) ?? new Set<string>();
        where.add(relative(REPO, file));
        found.set(name, where);
      }
    }
  }
  return found;
}

function namesInExamples(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const rel of EXAMPLES) {
    const text = readFileSync(join(REPO, rel), 'utf8');
    for (const m of text.matchAll(/^([A-Z][A-Z0-9_]+)=/gmu)) {
      const name = m[1] as string;
      const where = found.get(name) ?? new Set<string>();
      where.add(rel);
      found.set(name, where);
    }
  }
  return found;
}

/** A name counts as registered when it appears in a code span in § 2 of the register. */
function registered(): Set<string> {
  const text = readFileSync(REGISTER, 'utf8');
  const start = text.indexOf('## 2. Where every secret lives');
  const end = text.indexOf('## 3.', start);
  expect(start, 'the register has lost its § 2 heading').toBeGreaterThan(-1);
  const section = text.slice(start, end === -1 ? undefined : end);
  return new Set([...section.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1] as string));
}

describe('every environment variable the code reads is in the credentials register', () => {
  const reg = registered();
  const read = namesRead();
  const examples = namesInExamples();

  test('names read by the backend, pipelines and clients', () => {
    const missing = [...read]
      .filter(([name]) => !reg.has(name))
      .map(([name, where]) => `${name}  (read in ${[...where].join(', ')})`);
    expect(missing, 'add a row to plans/05-accounts-and-credentials.md § 2').toEqual([]);
  });

  test('names documented in the .env.example files', () => {
    const missing = [...examples]
      .filter(([name]) => !reg.has(name))
      .map(([name, files]) => `${name}  (documented in ${[...files].join(', ')})`);
    expect(missing, 'add a row to plans/05-accounts-and-credentials.md § 2').toEqual([]);
  });

  test('every VITE_ / EXPO_PUBLIC_ name the clients read is in its .env.example', () => {
    const missing = [...read]
      // `VITE_APP_VERSION` is optional and unset by design — registered, but not an example line.
      .filter(([name]) => name !== 'VITE_APP_VERSION')
      .filter(([name]) => {
        const own = ownExample(name);
        return own !== null && !examples.get(name)?.has(own);
      })
      .map(([name, where]) => `${name}  (read in ${[...where].join(', ')})`);
    expect(missing).toEqual([]);
  });
});
