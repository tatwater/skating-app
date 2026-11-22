import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MERGE_WORDS as MW } from '../body/tabs/shape/mergeWords';

/**
 * The unmerge's line, from `unmerge.receipt`: moving while its pages land, the count of what stayed
 * once the last one has, that every row went back — or, stalled, that it stopped before it finished,
 * why, and *Resume* for a viewer the server lets resume (a refusal is a toast). And the place a merge
 * is refused mid-unmerge: the server's sentence, with the same *Resume* when that unmerge stalled.
 */

const mocks = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  args: {} as Record<string, unknown>,
  resume: vi.fn(async (_args: unknown): Promise<unknown> => ({ unmergeActionId: 'u1' })),
  can: true,
  toasts: [] as unknown[],
}));
vi.mock('../reads/consoleReads', async (original) => ({
  ...(await original<typeof import('../reads/consoleReads')>()),
  useConsoleReadSet: (specs: Record<string, { args: unknown }>) => {
    const reads: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(specs)) {
      mocks.args[name] = spec.args;
      reads[name] = mocks.reads[name];
    }
    return { reads, retry: () => {}, live: true, failed: false, pending: false };
  },
}));
vi.mock('convex/react', () => ({ useMutation: () => mocks.resume }));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ can: (c: string) => mocks.can && c === 'corpus.duplicates' }),
}));
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: unknown) => mocks.toasts.push(t),
}));

const { UnmergeLeft, UnmergeLeftView, UnmergingNote, stallWhy, unmergeLeftLine } = await import(
  './UnmergeLeft'
);

const answer = (done: boolean, count: number, stalled: string | null = null) => ({
  unmergeActionId: 'u1' as never,
  done,
  stalled: stalled === null ? null : { code: 'pageFailed' as const, error: stalled },
  left: { count, byKind: count > 0 ? { reports: count } : {}, rows: [] },
});
/** A failed page's error text, as the scheduler records it on a deployment. */
const FAILED = 'Uncaught Error: Too many reads in a single function execution';

beforeEach(() => {
  mocks.reads = {};
  mocks.args = {};
  mocks.resume.mockReset();
  mocks.resume.mockImplementation(async () => ({ unmergeActionId: 'u1' }));
  mocks.can = true;
  mocks.toasts.length = 0;
});

describe('unmergeLeftLine', () => {
  it('says nothing before the unmerge’s row is there', () => {
    expect(unmergeLeftLine(undefined)).toBeNull();
    expect(unmergeLeftLine(null)).toBeNull();
  });

  it('says it is moving rows back while its pages land, with what stayed so far', () => {
    expect(unmergeLeftLine(answer(false, 0))).toBe(MW.unmerging);
    expect(unmergeLeftLine(answer(false, 2))).toBe(`${MW.unmerging} · ${MW.leftSince(2)}`);
  });

  it('says what stayed once it is done, or that every row went back', () => {
    expect(unmergeLeftLine(answer(true, 1))).toBe(
      '1 row had changed since the merge and stays where it is',
    );
    expect(unmergeLeftLine(answer(true, 1200))).toBe(
      '1,200 rows had changed since the merge and stay where they are',
    );
    expect(unmergeLeftLine(answer(true, 0))).toBe('Every row went back');
  });

  it('says a stalled one stopped before it finished — its reason is the detail, not the line', () => {
    expect(unmergeLeftLine(answer(false, 2, FAILED))).toBe(MW.unmergeStalled);
  });
});

describe('UnmergeLeftView', () => {
  it('draws the line, or the fallback until the unmerge’s row is read', () => {
    const { rerender } = render(<UnmergeLeftView receipt={answer(true, 3)} fallback="usual" />);
    expect(screen.getByText(MW.leftSince(3))).toBeInTheDocument();
    rerender(<UnmergeLeftView receipt={null} fallback="usual" />);
    expect(screen.getByText('usual')).toBeInTheDocument();
  });

  it('draws a stalled one’s reason under its line, and Resume only when given', () => {
    const onResume = vi.fn();
    const { rerender } = render(<UnmergeLeftView receipt={answer(false, 0, FAILED)} />);
    expect(screen.getByText(MW.unmergeStalled)).toBeInTheDocument();
    // The code in plain words, then the scheduler's error verbatim.
    expect(screen.getByText(`${MW.stallWhy.pageFailed} ${FAILED}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MW.resume })).toBeNull();
    rerender(
      <UnmergeLeftView receipt={answer(false, 0, FAILED)} resume={{ onResume, pending: true }} />,
    );
    expect(screen.getByRole('button', { name: MW.resume })).toBeDisabled();
  });
});

describe('stallWhy', () => {
  it('says each stall code in plain words, and a failed page’s error after it', () => {
    expect(stallWhy({ code: 'pageCanceled' })).toBe(MW.stallWhy.pageCanceled);
    expect(stallWhy({ code: 'mergedAgain' })).toBe('The body was merged again while it ran.');
    expect(stallWhy({ code: 'pageFailed', error: 'boom' })).toBe(`${MW.stallWhy.pageFailed} boom`);
    expect(stallWhy({ code: 'pageFailed', error: '' })).toBe(MW.stallWhy.pageFailed);
  });

  it('offers Resume for a stall of any code — the server names none a resume can’t help', () => {
    const onResume = vi.fn();
    for (const code of ['undone', 'recordGone', 'mergedAgain', 'pageMissing'] as const) {
      const { unmount } = render(
        <UnmergeLeftView
          receipt={{ ...answer(false, 0), stalled: { code } }}
          resume={{ onResume, pending: false }}
        />,
      );
      expect(screen.getByRole('button', { name: MW.resume })).toBeInTheDocument();
      unmount();
    }
  });
});

describe('UnmergeLeft, live', () => {
  it('running → done: reads the merge’s unmerge and follows it', () => {
    mocks.reads.receipt = answer(false, 0);
    const { rerender } = render(<UnmergeLeft mergeActionId="ma1" fallback="usual" />);
    expect(mocks.args.receipt).toEqual({ mergeActionId: 'ma1' });
    expect(screen.getByText(MW.unmerging)).toBeInTheDocument();
    mocks.reads.receipt = answer(true, 4);
    rerender(<UnmergeLeft mergeActionId="ma1" fallback="usual" />);
    expect(screen.getByText(MW.leftSince(4))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MW.resume })).toBeNull();
  });

  it('running → stalled → resumed → done', async () => {
    const user = userEvent.setup();
    mocks.reads.receipt = answer(false, 0);
    const view = render(<UnmergeLeft mergeActionId="ma1" />);
    mocks.reads.receipt = answer(false, 1, FAILED);
    view.rerender(<UnmergeLeft mergeActionId="ma1" />);
    await user.click(screen.getByRole('button', { name: MW.resume }));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ mergeActionId: 'ma1' }));
    mocks.reads.receipt = answer(false, 1);
    view.rerender(<UnmergeLeft mergeActionId="ma1" />);
    expect(screen.getByText(`${MW.unmerging} · ${MW.leftSince(1)}`)).toBeInTheDocument();
    mocks.reads.receipt = answer(true, 1);
    view.rerender(<UnmergeLeft mergeActionId="ma1" />);
    expect(screen.getByText(MW.leftSince(1))).toBeInTheDocument();
    expect(mocks.toasts).toEqual([]);
  });

  it('a refused resume is said in a toast, in the server’s words', async () => {
    const user = userEvent.setup();
    mocks.resume.mockImplementation(async () => {
      throw new ConvexError('This unmerge is still running.');
    });
    mocks.reads.receipt = answer(false, 0, FAILED);
    render(<UnmergeLeft mergeActionId="ma1" />);
    await user.click(screen.getByRole('button', { name: MW.resume }));
    await waitFor(() =>
      expect(mocks.toasts).toEqual([
        expect.objectContaining({
          title: 'Not resumed',
          description: 'This unmerge is still running.',
          tone: 'bad',
        }),
      ]),
    );
    // Pressable again once the refusal is said.
    await waitFor(() => expect(screen.getByRole('button', { name: MW.resume })).toBeEnabled());
  });

  it('offers no Resume to a viewer the server wouldn’t let resume', () => {
    mocks.can = false;
    mocks.reads.receipt = answer(false, 0, FAILED);
    render(<UnmergeLeft mergeActionId="ma1" />);
    expect(screen.getByText(MW.unmergeStalled)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: MW.resume })).toBeNull();
  });

  it('draws the fallback when the read fails — the unmerge landed all the same', async () => {
    mocks.reads.receipt = (await import('../reads/consoleReads')).retryAll([]);
    render(<UnmergeLeft mergeActionId="ma1" fallback="usual" />);
    expect(screen.getByText('usual')).toBeInTheDocument();
  });
});

describe('UnmergingNote, where a merge is refused mid-unmerge', () => {
  const SENTENCE = 'This body is still being unmerged. Merge it once that finishes.';
  const running = (stalled: string | null) => ({
    ...answer(false, 0, stalled),
    mergeActionId: 'ma9' as never,
  });

  it('says the server’s sentence while the unmerge runs, and asks by the pair’s bodies', () => {
    mocks.reads.running = running(null);
    render(<UnmergingNote sentence={SENTENCE} waterBodyIds={['wbA', 'wbB', 'wbC']} />);
    expect(mocks.args.running).toEqual({ waterBodyIds: ['wbA', 'wbB'] });
    expect(screen.getByRole('note')).toHaveTextContent(SENTENCE);
    expect(screen.queryByText(MW.unmergeStalled)).toBeNull();
    expect(screen.queryByRole('button', { name: MW.resume })).toBeNull();
  });

  it('offers Resume for that unmerge’s merge once it stalled', async () => {
    const user = userEvent.setup();
    mocks.reads.running = running(FAILED);
    render(<UnmergingNote sentence={SENTENCE} waterBodyIds={['wbA', 'wbB']} />);
    expect(screen.getByRole('note')).toHaveTextContent(MW.unmergeStalled);
    await user.click(screen.getByRole('button', { name: MW.resume }));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith({ mergeActionId: 'ma9' }));
  });

  it('says just the sentence when no unmerge is found, or the read fails', async () => {
    mocks.reads.running = null;
    const { rerender } = render(<UnmergingNote sentence={SENTENCE} waterBodyIds={['wbA']} />);
    expect(screen.getByRole('note')).toHaveTextContent(SENTENCE);
    mocks.reads.running = (await import('../reads/consoleReads')).retryAll([]);
    rerender(<UnmergingNote sentence={SENTENCE} waterBodyIds={['wbA']} />);
    expect(screen.queryByRole('button', { name: MW.resume })).toBeNull();
  });
});
