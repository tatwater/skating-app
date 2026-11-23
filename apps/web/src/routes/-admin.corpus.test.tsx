import { describe, expect, it, vi } from 'vitest';
import { CORPUS_TASKS } from '../components/admin/overview/overviewData';
import { overviewHref } from '../components/admin/overview/overviewLinks';

// The `-` prefix keeps this file out of the generated route tree (`routeFileIgnorePrefix`).

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}));

const { Route } = await import('./admin.corpus');
const route = Route as unknown as {
  path: string;
  options: { validateSearch: (raw: Record<string, unknown>) => Record<string, unknown> };
};

describe('the Corpus route', () => {
  it('is the library at /admin/corpus', () => {
    expect(route.path).toBe('/admin/corpus');
  });

  // Home's documented `/admin/corpus?task=…` (`overviewHref`) is rewritten to the old pages before it
  // is linked (`consolePathFor`); a hand-typed one still lands on the library, on its default lane.
  it.each(CORPUS_TASKS)(
    'takes ?task=%s without choking: the default lane, nothing kept',
    (task) => {
      const search = Object.fromEntries(
        new URLSearchParams(overviewHref({ kind: 'corpus', task }).split('?')[1]),
      );
      expect(search).toEqual({ task });
      expect(route.options.validateSearch(search)).toEqual({});
    },
  );

  it('keeps the library’s own params beside a stray task', () => {
    expect(
      route.options.validateSearch({ task: 'duplicates', lane: 'inactive', q: 'mas' }),
    ).toEqual({
      lane: 'inactive',
      q: 'mas',
    });
  });
});
