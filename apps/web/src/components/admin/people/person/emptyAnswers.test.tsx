import { render } from '@testing-library/react';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';

import { assertSeeded } from '@/test/seeded';

import { settledEmpty } from '../answers';
import { stubLayout } from '../list/testLayout';
import { accountRows } from './levers';
import { OpenAbout } from './PersonFeeds';
import { NOW, personOf, ROB } from './personFixtures';

/**
 * **Nothing is left out unless the server gave a complete, genuinely empty answer.** Every block on
 * the person page that can leave itself out — *Open about this person*, the *On the record* row —
 * goes through one rule (`settledEmpty`); these hold it over every state its read can answer in: a
 * number, a floor (capped), a figure still being prepared (pending), and none. (A failed person
 * read takes the whole page's note, with *Try again*; a `null` one is no such person.)
 */

beforeAll(stubLayout);

const linkTo = () => <a href="/x">x</a>;
const FLAG = (i: number) => ({
  flagId: `f${i}` as never,
  reason: 'spam' as const,
  targetType: 'report' as const,
  targetId: `r${i}`,
  status: 'open' as const,
  createdAt: NOW - i * 60_000,
});
const APPEAL = (i: number) => ({
  ticketId: `t${i}` as never,
  status: 'open' as const,
  createdAt: NOW - i * 60_000,
});

describe('the one rule', () => {
  it('leaves a block out only for zero, not capped, not pending', () => {
    assertSeeded(
      fc.property(fc.nat(3), fc.boolean(), fc.boolean(), (count, capped, pending) => {
        expect(settledEmpty({ count, capped, pending })).toBe(count === 0 && !capped && !pending);
      }),
    );
  });
});

describe('Open about this person, over every state of its read', () => {
  type State = [
    flags: number,
    appeals: number | null,
    flagsCapped: boolean,
    appealsCapped: boolean,
    pending: boolean,
  ];
  /** Draw the block for one state of its read, and hold it to the one rule. */
  function check(...[flags, appeals, flagsCapped, appealsCapped, pending]: State) {
    const person = {
      ...ROB,
      pending: pending ? (['flagSubjects'] as const) : ([] as const),
      open: {
        flags: Array.from({ length: flags }, (_, i) => FLAG(i)),
        flagsCapped,
        appeals: appeals === null ? null : Array.from({ length: appeals }, (_, i) => APPEAL(i)),
        appealsCapped: appeals !== null && appealsCapped,
      },
    } as unknown as typeof ROB;
    const { container, unmount } = render(<OpenAbout person={person} now={NOW} linkTo={linkTo} />);
    try {
      const block = container.querySelector('[data-slot="open-about"]');
      const count = flags + (appeals ?? 0);
      const capped = flagsCapped || (appeals !== null && appealsCapped);
      expect(block === null).toBe(count === 0 && !capped && !pending);
      if (block !== null) {
        // A floor or a figure not ready says so in words; a zero is never drawn.
        if (capped) expect(block.querySelector('[data-slot="open-capped"]')).not.toBeNull();
        if (pending) expect(block.querySelector('[data-slot="open-pending"]')).not.toBeNull();
        expect(block.querySelector('[data-slot="section-count"]')?.textContent ?? '').not.toMatch(
          /^0\+?$/,
        );
      }
    } finally {
      unmount();
    }
  }

  // Each way the block can answer, pinned — a few renders, not a search (the rule itself is
  // searched above, as pure code).
  it.each<State>([
    [0, null, false, false, false],
    [0, 0, false, false, false],
    [1, null, false, false, false],
    [0, 2, false, false, false],
    [0, 0, true, false, false],
    [0, 0, false, true, false],
    [0, null, false, true, false],
    [0, 0, false, false, true],
    [2, 1, true, true, true],
  ])('flags %i, appeals %s, capped %s/%s, pending %s', (...state) => {
    check(...state);
  });

  it('and a short random run over every state', () => {
    fc.assert(
      fc.property(
        fc.nat(2),
        fc.option(fc.nat(2), { nil: null }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (...state) => check(...state),
      ),
      { numRuns: 6 },
    );
  });
});

describe('the On the record row, over every state of its standing count', () => {
  it('is drawn unless nothing is hidden for certain, and never reads zero', () => {
    assertSeeded(
      fc.property(fc.nat(3), fc.boolean(), (total, capped) => {
        const p = personOf({
          hidden: {
            total,
            byKind: { report: total, post: 0, comment: 0, hazard: 0, accessAlert: 0 },
            capped,
          },
        });
        const row = accountRows(p, { now: NOW, self: false }).find((r) => r.key === 'record');
        expect(row === undefined).toBe(total === 0 && !capped);
        if (row !== undefined) expect(row.status).not.toMatch(/^0\+? /);
      }),
    );
  });
});
