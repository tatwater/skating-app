import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { stubLayout } from '../list/testLayout';
import { FACT_WORDS } from './factWords';
import { clampMeasure } from './kit-candidates/clamped-text';
import { defaultLinkTo, OpenAbout } from './PersonFeeds';
import { NOW, ROB } from './personFixtures';
import type { PersonRead } from './personModel';

/**
 * *Open about this person* draws what the server sends of each open item: the body a flag is on
 * (its `targetLabel`), the words a person wrote in their appeal — as their words, quoted, clamped
 * to four rendered lines with the rest a press away — and, when the labels were read only in part, says so.
 * Its links still go where they went (the old lists), whatever the item.
 */

beforeAll(stubLayout);
afterEach(() => vi.restoreAllMocks());

type Open = PersonRead['open'];
type Flag = Open['flags'][number];
type Appeal = NonNullable<Open['appeals']>[number];

const flag = (over: Partial<Flag> = {}): Flag => ({
  flagId: 'f1' as Flag['flagId'],
  reason: 'spam',
  targetType: 'report',
  targetId: 'r1',
  status: 'open',
  createdAt: NOW - 3_600_000,
  ...over,
});
const appeal = (over: Partial<Appeal> = {}): Appeal => ({
  ticketId: 't1' as Appeal['ticketId'],
  status: 'open',
  createdAt: NOW - 7_200_000,
  body: 'I was told the ice had been cut',
  ...over,
});

function draw(open: Partial<Open>) {
  const person = { ...ROB, open: { ...ROB.open, flags: [], appeals: [], ...open } };
  const { container } = render(<OpenAbout person={person} now={NOW} linkTo={defaultLinkTo} />);
  return container.querySelector('[data-slot="open-about"]') as HTMLElement;
}
const rows = (block: HTMLElement, slot: string) => [
  ...block.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`),
];

describe('a flag', () => {
  it('names the body it is on, after what it is on', () => {
    const block = draw({ flags: [flag({ targetLabel: 'Mascoma Lake' })] });
    const [row] = rows(block, 'open-flag');
    expect(row).toHaveTextContent('Spam flag on a report · Mascoma Lake');
    expect(row?.querySelector('[data-slot="open-flag-label"]')).toHaveTextContent('Mascoma Lake');
  });

  it('names nothing more for a flag on the person — their name is the page’s', () => {
    const block = draw({
      flags: [flag({ targetType: 'user', targetId: ROB.userId, targetLabel: 'Rob Tremblay' })],
    });
    const [row] = rows(block, 'open-flag');
    expect(row).toHaveTextContent('Spam flag on the person');
    expect(row).not.toHaveTextContent('Rob Tremblay');
  });

  it('draws no label when the server sent none, or a blank one', () => {
    const block = draw({ flags: [flag(), flag({ flagId: 'f2' as never, targetLabel: '  ' })] });
    for (const row of rows(block, 'open-flag')) {
      expect(row.querySelector('[data-slot="open-flag-label"]')).toBeNull();
      expect(row).toHaveTextContent('Spam flag on a report');
      expect(row.textContent).not.toContain(' · ');
    }
  });

  it('says when some flags couldn’t be named, and only then', () => {
    const named = draw({ flags: [flag({ targetLabel: 'Mascoma Lake' })] });
    expect(named.querySelector('[data-slot="open-labels-capped"]')).toBeNull();
    const block = draw({
      flags: [flag(), flag({ flagId: 'f2' as never })],
      flagLabelsCapped: true,
    });
    expect(block.querySelector('[data-slot="open-labels-capped"]')).toHaveTextContent(
      FACT_WORDS.flagLabelsCapped,
    );
  });

  it('says nothing of the cap when only a flag on the person went unlabeled: it names nothing more', () => {
    const block = draw({
      flags: [
        flag({ targetLabel: 'Mascoma Lake' }),
        flag({ flagId: 'f2' as never, targetType: 'user', targetId: ROB.userId }),
      ],
      flagLabelsCapped: true,
    });
    expect(block.querySelector('[data-slot="open-labels-capped"]')).toBeNull();
  });
});

describe('an appeal', () => {
  it('shows what the person wrote, quoted, under the appeal', () => {
    const block = draw({ appeals: [appeal()] });
    const [row] = rows(block, 'open-appeal');
    expect(row).toHaveTextContent('Appeal · waiting');
    expect(row?.querySelector('[data-slot="their-words"]')).toHaveTextContent(
      '“I was told the ice had been cut”',
    );
    expect(within(row as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('keeps what they wrote out of analytics, as a name is', () => {
    const block = draw({ appeals: [appeal()] });
    expect(block.querySelector('[data-slot="their-words-text"]')).toHaveClass('ph-no-capture');
  });

  it('bounds them by the lines they take on screen, whatever their length in characters', async () => {
    // A short appeal that wraps past four lines at a phone's width: cut, though short.
    vi.spyOn(clampMeasure, 'overflows').mockReturnValue(true);
    const short = 'The ice was cut.';
    const block = draw({ appeals: [appeal({ body: short })] });
    const words = block.querySelector('[data-slot="their-words"]') as HTMLElement;
    const text = words.querySelector('[data-slot="clamped-text-body"]') as HTMLElement;
    expect(text.style.webkitLineClamp).toBe('4');
    // Every word is in the page; the clamp is what bounds them.
    expect(text).toHaveTextContent(`“${short}”`);
    const more = within(words).getByRole('button', { name: FACT_WORDS.showAll });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(text.style.webkitLineClamp).toBe('');
    expect(within(words).getByRole('button', { name: FACT_WORDS.showLess })).toHaveFocus();
  });

  it('offers nothing more for long words that fit', () => {
    vi.spyOn(clampMeasure, 'overflows').mockReturnValue(false);
    const long = 'The ice by the north launch had been cut for the derby. '.repeat(8).trim();
    const block = draw({ appeals: [appeal({ body: long })] });
    expect(within(block).queryByRole('button')).toBeNull();
    expect(block.querySelector('[data-slot="clamped-text-body"]')).toHaveTextContent(long);
  });

  it('draws nothing in quotes for an appeal with no words', () => {
    const block = draw({ appeals: [appeal({ body: '   ' })] });
    expect(block.querySelector('[data-slot="their-words"]')).toBeNull();
    expect(rows(block, 'open-appeal')[0]).toHaveTextContent('Appeal · waiting');
  });
});

describe('where its links go', () => {
  it('sends a flag to the flags list and an appeal to support, as before', () => {
    const block = draw({ flags: [flag({ targetLabel: 'Mascoma Lake' })], appeals: [appeal()] });
    expect(
      within(block)
        .getAllByRole('link', { name: /Handle/ })
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/admin/flags', '/admin/support']);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});
