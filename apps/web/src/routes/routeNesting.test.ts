import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A structural guard on file-based routing: **every parent route must render its children.**
 *
 * TanStack derives nesting from filenames, so `admin.water.$id.tsx` silently became a child of
 * `admin.water.tsx` — which was a leaf page with no `<Outlet/>`. The router matched, the params
 * resolved, and React rendered the queues table anyway, so `/admin/water/:id` and `/admin/users/:id`
 * (ban, suspend, grant-role) looked exactly like dead links. Nothing failed; the pages just never
 * mounted. The fix was to rename both parents to `.index.tsx` so they became siblings.
 *
 * Cheap to reintroduce — it takes only adding `admin.foo.$id.tsx` beside an existing `admin.foo.tsx`
 * — and invisible in every other test, since each page renders fine in isolation. Hence a test on
 * the file layout itself rather than on any component.
 *
 * The check follows the bound component's imports, because a route file is allowed to bind a layout
 * component instead of owning the outlet: `admin.tsx` is a two-line binding to `AdminRoot`, which
 * picks between two shells (the console and the old gate and sidebar) and owns no outlet itself.
 * A component without its own `<Outlet/>` passes only if **every** local component it renders does
 * — a shell switch whose one branch dropped the outlet would otherwise pass on the other's.
 */

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));

const routeFiles = readdirSync(ROUTES_DIR).filter(
  (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'),
);

/** Route files whose path segments are a prefix of another route file's — i.e. layout routes. */
function childrenOf(file: string): string[] {
  const prefix = `${file.replace(/\.tsx$/, '')}.`;
  return routeFiles.filter((f) => f !== file && f.startsWith(prefix));
}

const SRC_DIR = resolve(ROUTES_DIR, '..');

/** A local import's file — relative or `@/` — or undefined for a package. */
function localFile(fromFile: string, spec: string): string | undefined {
  const base = spec.startsWith('@/')
    ? resolve(SRC_DIR, spec.slice(2))
    : spec.startsWith('.')
      ? resolve(dirname(fromFile), spec)
      : undefined;
  return base === undefined ? undefined : `${base}.tsx`;
}

/** The file `name` is imported from in `source` (read from `file`), if it's a local one. */
function importedFrom(file: string, source: string, name: string): string | undefined {
  const spec = source.match(
    new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'([^']+)'`),
  )?.[1];
  return spec === undefined ? undefined : localFile(file, spec);
}

/**
 * Whether `file` renders an outlet: its own, or — up to `depth` hops down — one in every local
 * component it renders as JSX.
 */
function rendersOutlet(file: string, depth: number): boolean {
  const source = readFileSync(file, 'utf8');
  if (source.includes('<Outlet')) return true;
  if (depth === 0) return false;
  const rendered = [...new Set([...source.matchAll(/<([A-Z]\w*)/g)].map((m) => m[1] as string))];
  const children = rendered
    .map((name) => importedFrom(file, source, name))
    .filter((f): f is string => f !== undefined);
  return children.length > 0 && children.every((f) => rendersOutlet(f, depth - 1));
}

/** Whether the route file renders its children: its own outlet, or the component it binds. */
function routeRendersOutlet(file: string): boolean {
  const path = resolve(ROUTES_DIR, file);
  const source = readFileSync(path, 'utf8');
  if (source.includes('<Outlet')) return true;
  const component = source.match(/component:\s*(\w+)/)?.[1];
  if (!component) return false;
  const bound = importedFrom(path, source, component);
  return bound !== undefined && rendersOutlet(bound, 2);
}

describe('route nesting', () => {
  const parents = routeFiles.filter((f) => childrenOf(f).length > 0);

  it('finds the layout routes', () => {
    // A sanity check on the filename convention itself: if this ever hits zero, the loop below
    // passes vacuously and the guard is silently dead.
    expect(parents.length).toBeGreaterThan(0);
  });

  it.each(parents)('%s renders an Outlet for its children', (file) => {
    expect(
      routeRendersOutlet(file),
      `${file} is the parent of ${childrenOf(file).join(', ')} but renders no <Outlet/>, so those ` +
        `routes match the URL and never mount. Rename it to ${file.replace(/\.tsx$/, '.index.tsx')} ` +
        'to make them siblings, or render an <Outlet/> if it really is a layout.',
    ).toBe(true);
  });
});

/**
 * **`__root` is the only place that mounts the `AuthGate`**, and the gate is what renders the
 * `AppShell`. A route that mounts a second one renders a second navbar *inside the page* — which
 * is what `/post` did when the console landed (A10-5). It is an easy mistake to make, because a
 * route that wants authentication looks like a route that should say so, and it fails silently:
 * the page works, the gate resolves the same way twice, and the only symptom is a duplicated
 * header a long way down the screen.
 *
 * A mention in a comment is fine — several routes explain what the gate does with them.
 */
describe('the auth gate is mounted once', () => {
  it.each(routeFiles.filter((f) => f !== '__root.tsx'))('%s does not render its own', (file) => {
    const source = readFileSync(resolve(ROUTES_DIR, file), 'utf8');
    expect(
      source.includes('<AuthGate'),
      `${file} renders its own <AuthGate/>, but __root already wraps every route in one — this ` +
        'draws a second AppShell (navbar and all) inside the page. Remove it; the root gate ' +
        'already redirects an unauthenticated visitor.',
    ).toBe(false);
  });
});
