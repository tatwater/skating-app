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
 * The check follows one import hop, because a route file is allowed to bind a layout component
 * instead of owning the outlet: `admin.tsx` is a two-line binding and the real `<Outlet/>` lives in
 * `components/admin/AdminLayout`.
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

/** The route's own source, plus the source of the component it binds (one hop, if local). */
function renderedSources(file: string): string[] {
  const source = readFileSync(resolve(ROUTES_DIR, file), 'utf8');
  const component = source.match(/component:\s*(\w+)/)?.[1];
  if (!component) return [source];

  const importPath = source.match(
    new RegExp(`import\\s*\\{[^}]*\\b${component}\\b[^}]*\\}\\s*from\\s*'([^']+)'`),
  )?.[1];
  if (!importPath?.startsWith('.')) return [source];

  return [source, readFileSync(resolve(ROUTES_DIR, `${importPath}.tsx`), 'utf8')];
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
      renderedSources(file).some((src) => src.includes('<Outlet')),
      `${file} is the parent of ${childrenOf(file).join(', ')} but renders no <Outlet/>, so those ` +
        `routes match the URL and never mount. Rename it to ${file.replace(/\.tsx$/, '.index.tsx')} ` +
        'to make them siblings, or render an <Outlet/> if it really is a layout.',
    ).toBe(true);
  });
});
