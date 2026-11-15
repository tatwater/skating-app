import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { KeysProvider } from '@/lib/keys';
import { AccessView, WALK_WORDS } from './access/AccessView';
import { BOARD_TODAY, MASCOMA_ACCESS } from './access/accessFixtures';
import { stubJsdomAnimations } from './jsdomStubs';
import { WaterView } from './water/WaterView';
import { MASCOMA_WATER } from './water/waterFixtures';

/**
 * Every value a tab shows that a server field qualifies — a straight-line distance, a modeled
 * depth, a moderator's word — drawn in its weaker state, and the weaker wording on screen: an
 * unrouted walk never as a bare number, an estimate never as a sounding, a hand-entered depth
 * never without its evidence or the lack of it. The phase doc's qualifier table names the rest
 * (Names, Places and Shape test theirs beside their views).
 */

beforeAll(stubJsdomAnimations);

const inKeys = (node: ReactNode) => <KeysProvider>{node}</KeysProvider>;

describe('a qualified value is drawn in its weaker state', () => {
  it('Access: a straight-line walk reads "at least", never as a measured route', () => {
    const [first, ...rest] = MASCOMA_ACCESS.putIns;
    if (first === undefined) throw new Error('The fixture has no put-in.');
    const data = {
      ...MASCOMA_ACCESS,
      putIns: [{ ...first, walk: { meters: 412, atLeast: true } }, ...rest],
    };
    const { container } = render(inKeys(<AccessView data={data} now={BOARD_TODAY} />));
    const walks = [...container.querySelectorAll<HTMLElement>('[data-slot="put-in-walk"]')];
    const floor = walks.find((w) => w.textContent?.includes('412'));
    expect(floor).toHaveTextContent(`${WALK_WORDS.atLeast}412m`);
    expect(floor).toHaveAttribute('title', WALK_WORDS.why);
    // A routed walk beside it stays plain: the floor is said only where it is one.
    const routed = walks.find((w) => w.textContent?.includes('48'));
    expect(routed).not.toHaveTextContent(WALK_WORDS.atLeast);
    // Distances only: nothing about the walk says the way or the ice is safe.
    expect(container.textContent).not.toMatch(/\bsafe|passable|clear to/i);
  });

  it('Water: a modeled depth reads as an estimate; a moderator’s depth carries its evidence', () => {
    const operator = {
      ...MASCOMA_WATER,
      depth: {
        ...MASCOMA_WATER.depth,
        rungs: [...MASCOMA_WATER.depth.rungs, { source: 'operator' as const, mean: null, max: 25 }],
      },
    };
    const { rerender } = render(inKeys(<WaterView data={operator} />));
    const row = (name: string) => {
      const cell = screen
        .getAllByText(name)
        .map((el) => el.closest<HTMLElement>('[data-slot="depth-source"]'))
        .find((el) => el !== null);
      if (cell == null) throw new Error(`No depth row for ${name}.`);
      return cell;
    };
    expect(within(row('HydroLAKES')).getByText('Modeled · an estimate')).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: 'HydroLAKES, 8.1 m' }).parentElement,
    ).toHaveTextContent('~8.1');
    expect(
      within(row('A moderator')).getByText('Entered by hand · no source noted'),
    ).toBeInTheDocument();
    rerender(inKeys(<WaterView data={{ ...operator, depthNote: 'NH Fish & Game, 1998 chart' }} />));
    expect(within(row('A moderator')).getByText('NH Fish & Game, 1998 chart')).toBeInTheDocument();
  });
});
