import { render } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '../../body/tabs/jsdomStubs';
import { failedRead } from '../../reads/readFailureFixtures';
import { OOM_LOG, OOM_VIEW } from './imageryFixtures';

/**
 * **An attempt's log wired to `machineryImagery.attemptLog`**: the real `LiveAttemptLog` and log,
 * with only the read layer and the toast queue stood in. A read that fails is a toast with *Try
 * again* (D268), never a throw that reaches the route's crash screen.
 */

type Asked = { name: string; args: Record<string, unknown> };
const h = {
  asked: [] as Asked[],
  answer: (_args: Record<string, unknown>): unknown => undefined,
  retry: vi.fn(),
};
const toasts = vi.fn();

vi.doMock('@/components/admin/reads/consoleReads', async (orig) => {
  const actual = await orig<typeof import('@/components/admin/reads/consoleReads')>();
  return {
    ...actual,
    useConsoleReadSet: (specs: Record<string, { query: never; args: never } | null>) => {
      const reads: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(specs)) {
        if (spec === null) continue;
        h.asked.push({ name: getFunctionName(spec.query), args: spec.args });
        reads[k] = h.answer(spec.args);
      }
      return { reads, retry: () => {}, live: true, failed: false, pending: false };
    },
  };
});
vi.doMock('@/components/kit/toast', async (orig) => ({
  ...(await orig<typeof import('@/components/kit/toast')>()),
  toast: (o: unknown) => toasts(o),
}));

const { LiveAttemptLog } = await import('./AttemptLog');

const ATTEMPT = OOM_VIEW.attempts[1]?.id as NonNullable<(typeof OOM_VIEW.attempts)[1]>['id'];

beforeAll(stubJsdomAnimations);
beforeEach(() => {
  h.asked = [];
  h.retry.mockReset();
  toasts.mockReset();
  h.answer = () => ({ page: [...OOM_LOG].reverse(), isDone: true, continueCursor: 'c1' });
});

describe('the live attempt log', () => {
  it('reads 200 lines a page from the start, newest first, and draws them oldest first', () => {
    render(<LiveAttemptLog attemptId={ATTEMPT} failed />);
    expect(h.asked.at(-1)).toEqual({
      name: 'machineryImagery:attemptLog',
      args: { attemptId: ATTEMPT, paginationOpts: { numItems: 200, cursor: null } },
    });
    const log = document.querySelector('[data-slot="attempt-log"]');
    expect(log?.hasAttribute('data-loading')).toBe(false);
    const text = log?.textContent ?? '';
    const first = OOM_LOG[0]?.text ?? '';
    const lastLine = OOM_LOG.at(-1)?.text ?? '';
    expect(text.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(first)).toBeLessThan(text.indexOf(lastLine));
  });

  it('a read that fails is a toast with Try again, and the page stays up', () => {
    h.answer = () => failedRead(h.retry);
    render(<LiveAttemptLog attemptId={ATTEMPT} failed />);
    expect(toasts).toHaveBeenCalledTimes(1);
    const shown = toasts.mock.calls[0]?.[0] as {
      title: string;
      tone: string;
      action: { label: string; onAction: () => void };
    };
    expect(shown).toMatchObject({ title: 'The log didn’t load.', tone: 'bad' });
    expect(shown.action.label).toBe('Try again');
    shown.action.onAction();
    expect(h.retry).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-slot="attempt-log"]')).not.toBeNull();
  });
});
