import { describe, expect, it, vi } from 'vitest';
import { taskLaneById } from '../components/admin/corpus/taskLanes';
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

  // Home's documented links (`overviewHref`) name a lane: a built one is kept, with nothing else;
  // one not built yet lands on the library's default lane, never an error.
  it.each(CORPUS_TASKS)('takes Home’s link for %s', (task) => {
    const href = overviewHref({ kind: 'corpus', task });
    const search = Object.fromEntries(new URLSearchParams(href.split('?')[1] ?? ''));
    const kept = route.options.validateSearch(search);
    if (search.lane !== undefined && taskLaneById(search.lane) !== null) {
      expect(kept).toEqual({ lane: search.lane });
    } else {
      expect(kept).toEqual({});
    }
  });

  it('drops a stale ?task= from before the lanes', () => {
    expect(route.options.validateSearch({ task: 'nameConflicts' })).toEqual({});
  });

  it('keeps the library’s own params beside a stray task', () => {
    expect(
      route.options.validateSearch({ task: 'duplicates', lane: 'inactive', q: 'mas' }),
    ).toEqual({
      lane: 'inactive',
      q: 'mas',
    });
  });
});
