import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const paginated = vi.hoisted(() => ({
  value: { results: [] as unknown[], status: 'LoadingFirstPage', loadMore: vi.fn() },
  args: [] as unknown[],
}));
vi.mock('convex/react', async (orig) => ({
  ...(await orig<typeof import('convex/react')>()),
  usePaginatedQuery: (...args: unknown[]) => {
    paginated.args = args;
    return paginated.value;
  },
}));

import { LiveRunTail, logLineOf, RunTail } from './RunTail';
import { cappedEvents, LAST_FLUSH, LOAD_ID, loadEvents, NOW_STALLED, ZONE } from './runFixtures';
import type { LivenessView } from './runViews';

const STALLED: LivenessView = {
  state: 'stalled',
  quietMs: NOW_STALLED - LAST_FLUSH,
  expectedMs: 180_000,
  waitUntil: null,
};
const lines = () =>
  [...document.querySelectorAll('[data-slot="log-line"]')].map((l) => l.textContent);

describe('a stored line', () => {
  test('its writer time, its kind word toned, its text', () => {
    expect(logLineOf(loadEvents()[0] as never, ZONE)).toEqual({
      id: 0,
      time: '13:26:04',
      word: 'start',
      tone: 'stage',
      text: 'Run started · full canonical, 5 states · dev',
    });
    expect(
      logLineOf({ seq: 1, loggedAt: 0, kind: 'beat', text: 'x', dropped: null }, 'UTC'),
    ).toEqual({
      id: 1,
      time: '00:00:00',
      word: 'beat',
      text: 'x',
    });
    expect(logLineOf({ seq: 2, loggedAt: 0, kind: 'new', text: 'y', dropped: null }).word).toBe(
      'new',
    );
  });

  test('the cap row counts what was not kept, whatever its text', () => {
    const [cap, close] = cappedEvents().slice(-2);
    expect(logLineOf(cap as never, ZONE)).toMatchObject({
      word: 'cap',
      tone: 'warn',
      text: "1,204 more lines past the log's limit weren't kept · the terminal and the log file have every line",
    });
    expect(
      logLineOf({ seq: 3, loggedAt: 0, kind: 'cap', text: 'whatever', dropped: null }).text,
    ).toMatch(/^Lines past the log's limit/);
    expect(logLineOf({ seq: 3, loggedAt: 0, kind: 'cap', text: '', dropped: 1 }).text).toMatch(
      /^1 more line past/,
    );
    // A close that says it failed is red.
    expect(logLineOf(close as never).tone).toBe('bad');
  });
});

describe('the tail', () => {
  const base = {
    more: false,
    state: 'live' as const,
    liveness: STALLED,
    lastHeardAt: LAST_FLUSH,
    now: NOW_STALLED,
    timeZone: ZONE,
  };

  test('loading, then the lines oldest first with the page own stalled line last', () => {
    const { rerender } = render(<RunTail {...base} events={undefined} />);
    expect(document.querySelector('[data-slot="run-tail"][data-loading]')).not.toBeNull();
    rerender(<RunTail {...base} events={cappedEvents()} />);
    const drawn = lines();
    expect(drawn).toHaveLength(11);
    expect(drawn[0]).toMatch(/^13:26:04 {2}start/);
    expect(drawn[8]).toMatch(/1,204 more lines/);
    expect(drawn[10]).toMatch(/^14:12:00 {2}stalled {2}no flush since 13:31:18/);
    expect(document.querySelectorAll('[data-slot="log-line"][data-fail]')).toHaveLength(1);
  });

  test('no quiet line once the run has ended; an empty log says so', () => {
    const { rerender } = render(<RunTail {...base} state="finished" events={loadEvents()} />);
    expect(lines()).toHaveLength(8);
    rerender(<RunTail {...base} state="finished" events={[]} />);
    expect(screen.getByText('No log lines recorded for this run')).toBeInTheDocument();
  });

  test('scrolling to the top asks for the older page, once at a time', () => {
    const onLoadOlder = vi.fn();
    const { rerender } = render(
      <RunTail {...base} events={loadEvents()} more onLoadOlder={onLoadOlder} />,
    );
    expect(screen.getByText('Scroll up for full log output')).toBeInTheDocument();
    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    rerender(
      <RunTail {...base} events={loadEvents()} more loadingOlder onLoadOlder={onLoadOlder} />,
    );
    expect(screen.getByText('Loading earlier lines')).toBeInTheDocument();
    fireEvent.scroll(viewport);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    rerender(<RunTail {...base} events={loadEvents()} more={false} onLoadOlder={onLoadOlder} />);
    fireEvent.scroll(viewport);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});

describe('the wired tail', () => {
  test('reads 200 newest first, draws them oldest first, and pages older', () => {
    const { rerender } = render(
      <LiveRunTail
        runId={LOAD_ID}
        {...{ state: 'finished', liveness: { state: 'finished' }, lastHeardAt: null, now: 0 }}
      />,
    );
    expect(paginated.args[1]).toEqual({ runId: LOAD_ID });
    expect(paginated.args[2]).toEqual({ initialNumItems: 200 });
    expect(document.querySelector('[data-loading]')).not.toBeNull();
    paginated.value = {
      results: [...loadEvents()].reverse(),
      status: 'CanLoadMore',
      loadMore: vi.fn(),
    };
    rerender(
      <LiveRunTail
        runId={LOAD_ID}
        state="finished"
        liveness={{ state: 'finished' }}
        lastHeardAt={null}
        now={0}
        timeZone={ZONE}
      />,
    );
    expect(lines()[0]).toMatch(/^13:26:04/);
    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    fireEvent.scroll(viewport);
    expect(paginated.value.loadMore).toHaveBeenCalledWith(200);
  });
});
