import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { UnmergeLive } from '../../shell/UnmergeLeft';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { BodyHistorySection } from './BodyLeftColumn';
import { BODY_NOW } from './bodyFixtures';
import { bodyHistory } from './bodyModel';

/**
 * The History the console shows (the Body console's left column): an unmerge's row says how it went
 * from its own row, and a merge recorded before version 2 says why it can't be undone — on the row,
 * where the console's History actually is.
 */

beforeAll(stubJsdomAnimations);

const at = BODY_NOW - 60_000;

describe('BodyHistorySection', () => {
  it('draws a row’s second line under what happened, and none where a row has nothing more', () => {
    const entries = bodyHistory([
      {
        id: 'u1',
        action: 'unmerge_waterbody',
        targetType: 'waterbody',
        targetId: 'b',
        createdAt: at,
        actor: { displayName: 'Sarah Berman', username: 'sarah' },
        metadata: { done: true, left: { count: 3 } },
      },
      {
        id: 'm1',
        action: 'merge_waterbody',
        targetType: 'waterbody',
        targetId: 'b',
        createdAt: at - 1,
        actor: null,
        undo: { state: 'unavailable', why: 'Recorded before merges kept everything.' },
      },
      {
        id: 's1',
        action: 'set_standing',
        targetType: 'waterbody',
        targetId: 'b',
        createdAt: at - 2,
        actor: null,
      },
    ]);
    const { container } = render(
      <BodyHistorySection
        history={{ entries, capped: false }}
        now={BODY_NOW}
        timeZone="America/New_York"
      />,
    );
    expect(
      screen.getByText('3 rows had changed since the merge and stay where they are'),
    ).toBeInTheDocument();
    expect(screen.getByText('Recorded before merges kept everything.')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="body-history-line"]')).toHaveLength(2);
  });

  it('draws an unmerge row live where the route provides it — History’s one action — and the stored line otherwise', () => {
    const entries = bodyHistory([
      {
        id: 'u1',
        action: 'unmerge_waterbody',
        targetType: 'waterbody',
        targetId: 'b',
        createdAt: at,
        actor: null,
        undoesActionId: 'ma1',
        metadata: { done: false, left: { count: 0 } },
      },
    ]);
    const line = vi.fn((mergeActionId: string, stored: ReactNode) => (
      <span>
        live {mergeActionId} over {stored}
      </span>
    ));
    render(
      <UnmergeLive.Provider value={{ line, note: () => null }}>
        <BodyHistorySection history={{ entries, capped: false }} now={BODY_NOW} />
      </UnmergeLive.Provider>,
    );
    expect(line).toHaveBeenCalledWith('ma1', 'Moving rows back…');
    expect(screen.getByText(/live ma1 over Moving rows back…/)).toBeInTheDocument();
  });
});
