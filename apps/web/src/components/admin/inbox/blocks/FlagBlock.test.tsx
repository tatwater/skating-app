import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BOARD_NOW, SAFETY_ITEM, SAFETY_MANY } from '../handlers/Flag/flagFixtures';
import { FlagBlock } from './FlagBlock';
import { listTotalOf } from './listCut';

/** The rule's count: the section slug's end. */
const ruleCount = () => document.querySelector('[data-slot="flag-block"]')?.textContent ?? '';

describe('the flags, served short of the item’s count', () => {
  it('ends the rule in the item’s count, a floor, and says how many of how many', () => {
    const cut = { ...SAFETY_MANY, memberCount: 500, memberCountIsFloor: true, flagsCut: true };
    render(
      <FlagBlock
        flags={cut.flags}
        total={listTotalOf(cut, cut.flagsCut)}
        targetType="report"
        now={BOARD_NOW}
      />,
    );
    expect(ruleCount()).toContain('500+');
    expect(screen.getByText('Showing 2 of 500+ flags')).toBeInTheDocument();
  });

  it('counts a single flag served from many as the many, never one', () => {
    const cut = { ...SAFETY_ITEM, memberCount: 40, flagsCut: true };
    render(
      <FlagBlock
        flags={cut.flags}
        total={listTotalOf(cut, cut.flagsCut)}
        targetType="report"
        now={BOARD_NOW}
      />,
    );
    expect(screen.getByText('Flags')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 40 flags')).toBeInTheDocument();
  });

  it('draws no line, and the page’s own count, while the list is whole', () => {
    render(
      <FlagBlock
        flags={SAFETY_MANY.flags}
        total={listTotalOf(SAFETY_MANY, SAFETY_MANY.flagsCut)}
        targetType="report"
        now={BOARD_NOW}
      />,
    );
    expect(screen.queryByText(/^Showing/)).toBeNull();
    expect(ruleCount()).toContain('2');
  });
});
