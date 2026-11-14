import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const convex = vi.hoisted(() => ({
  /** Each `useQueries` call's query keys and arguments, in order. */
  calls: [] as Record<string, unknown>[],
  results: new Map<string, unknown>(),
}));
vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQueries: (
      queries: Record<string, { query: Parameters<typeof getFunctionName>[0]; args: unknown }>,
    ) => {
      convex.calls.push(Object.fromEntries(Object.entries(queries).map(([k, q]) => [k, q.args])));
      return Object.fromEntries(
        Object.entries(queries).map(([k, q]) => [k, convex.results.get(getFunctionName(q.query))]),
      );
    },
  };
});

const captured = vi.hoisted(() => ({ exceptions: [] as unknown[], sentry: true }));
vi.mock('@sentry/tanstackstart-react', () => ({
  captureException: (e: unknown) => captured.exceptions.push(e),
}));
vi.mock('@/lib/env', () => ({
  isConfigured: {
    get sentry() {
      return captured.sentry;
    },
  },
}));

import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { read, resetReadPauses, retryReads, TabReadBoundary, useTabReads } from './tabReads';

const BODY = 'k1' as Id<'waterBodies'>;

beforeEach(() => {
  captured.exceptions = [];
  captured.sentry = true;
  convex.calls = [];
  convex.results.clear();
  resetReadPauses();
});

function Reader({ name, skip = false }: { name: string; skip?: boolean }) {
  const { got, retry } = useTabReads('test:k1', {
    body: read(api.waterBodies.get, { waterBodyId: BODY }),
    standing: skip ? null : read(api.standing.retentionForBody, { waterBodyId: BODY }),
  });
  const body = got.body;
  return (
    <p>
      {name}: {body === undefined ? 'waiting' : body instanceof Error ? 'failed' : 'read'}
      {got.standing === undefined ? ' · no standing' : ''}
      <button type="button" onClick={retry}>
        again {name}
      </button>
    </p>
  );
}

describe('useTabReads', () => {
  it('reads each spec, skips a null one, and hands back a failure as its Error', () => {
    convex.results.set('waterBodies:get', new Error('boom'));
    render(<Reader name="a" skip />);
    expect(screen.getByText(/a: failed · no standing/)).toBeVisible();
    expect(convex.calls.at(-1)).toEqual({ body: { waterBodyId: BODY } });
  });

  it('keeps one query set while the arguments’ values hold', () => {
    const seen: unknown[] = [];
    function Probe() {
      const { got } = useTabReads('test:k1', {
        body: read(api.waterBodies.get, { waterBodyId: BODY }),
      });
      seen.push(got);
      return null;
    }
    const { rerender } = render(<Probe />);
    rerender(<Probe />);
    rerender(<Probe />);
    // The same arguments, rebuilt each render, ask for the same reads every time.
    expect(new Set(convex.calls.map((c) => JSON.stringify(c))).size).toBe(1);
  });

  it('Try again lets go of every reader under the key for a commit, then reads again', async () => {
    convex.results.set('waterBodies:get', new Error('boom'));
    render(
      <>
        <Reader name="a" />
        <Reader name="b" />
      </>,
    );
    expect(screen.getByText(/a: failed/)).toBeVisible();
    convex.results.set('waterBodies:get', { available: false });
    convex.calls = [];
    await userEvent.click(screen.getByRole('button', { name: 'again a' }));
    await waitFor(() => expect(screen.getByText(/b: read/)).toBeVisible());
    expect(screen.getByText(/a: read/)).toBeVisible();
    // Both readers dropped their reads (an empty set) before either took them again.
    const empties = convex.calls.findIndex((c) => Object.keys(c).length === 0);
    const firstFull = convex.calls.findIndex((c) => Object.keys(c).length > 0);
    expect(empties).toBeGreaterThanOrEqual(0);
    expect(firstFull).toBeGreaterThan(empties);
  });

  it('a second retry while one is under way is the same retry', async () => {
    render(<Reader name="a" />);
    act(() => {
      retryReads('test:k1');
      retryReads('test:k1');
    });
    expect(screen.getByText(/a: waiting/)).toBeVisible();
    await waitFor(() => expect(convex.calls.at(-1)).toHaveProperty('body'));
  });
});

describe('failures are heard', () => {
  it('a read that turns failed goes to Sentry once, and again only after it recovers', () => {
    convex.results.set('waterBodies:get', new Error('boom'));
    const { rerender } = render(<Reader name="a" skip />);
    rerender(<Reader name="a" skip />);
    rerender(<Reader name="a" skip />);
    expect(captured.exceptions).toHaveLength(1);
    convex.results.set('waterBodies:get', { available: false });
    rerender(<Reader name="a" skip />);
    convex.results.set('waterBodies:get', new Error('again'));
    rerender(<Reader name="a" skip />);
    expect(captured.exceptions).toHaveLength(2);
  });

  it('nothing is sent without a DSN', () => {
    captured.sentry = false;
    convex.results.set('waterBodies:get', new Error('boom'));
    render(<Reader name="a" skip />);
    expect(captured.exceptions).toEqual([]);
  });
});

const crash = { on: true };

describe('TabReadBoundary', () => {
  function Crashy() {
    const { got } = useTabReads('test:k1', {
      body: read(api.waterBodies.get, { waterBodyId: BODY }),
    });
    if (crash.on) throw new Error('drawn wrong');
    return <p>drawn {got.body === undefined ? 'waiting' : 'read'}</p>;
  }

  it('catches a crash below a tab, reports it, and Try again reads afresh and draws again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    crash.on = true;
    convex.results.set('waterBodies:get', { available: false });
    render(
      <TabReadBoundary readsKey="test:k1">
        <Crashy />
      </TabReadBoundary>,
    );
    expect(screen.getByText('This tab couldn’t be shown')).toBeVisible();
    expect(captured.exceptions.length).toBeGreaterThan(0);
    crash.on = false;
    convex.calls = [];
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('drawn read')).toBeVisible());
    // The reads were let go and taken again: an empty set, then the read.
    const empty = convex.calls.findIndex((c) => Object.keys(c).length === 0);
    expect(empty).toBeGreaterThanOrEqual(0);
    expect(convex.calls.slice(empty).some((c) => 'body' in c)).toBe(true);
    vi.restoreAllMocks();
  });

  it('another body starts clean', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    crash.on = true;
    const { rerender } = render(
      <TabReadBoundary readsKey="test:k1">
        <Crashy />
      </TabReadBoundary>,
    );
    expect(screen.getByText('This tab couldn’t be shown')).toBeVisible();
    crash.on = false;
    rerender(
      <TabReadBoundary readsKey="test:k2">
        <Crashy />
      </TabReadBoundary>,
    );
    expect(screen.getByText(/^drawn/)).toBeVisible();
    vi.restoreAllMocks();
  });
});
