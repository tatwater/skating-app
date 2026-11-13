import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { laneFraction } from './kit-candidates/lane-timeline';
import { StandingTabView, type StandingTabViewProps } from './StandingTabView';
import {
  ACTIVE,
  ACTIVE_SINCE,
  BODY_NOW,
  DORMANT_BY_HAND,
  DORMANT_ON_RULING,
  MASCOMA_RETENTION,
  MASCOMA_RETENTION_WIRED,
  REMOVED,
} from './standingFixtures';

const base: StandingTabViewProps = {
  standing: ACTIVE,
  activeSince: ACTIVE_SINCE,
  retention: MASCOMA_RETENTION,
  now: BODY_NOW,
  canSetStanding: true,
  canRemove: true,
  onSetDormant: vi.fn(async () => {}),
  onSetActive: vi.fn(async () => {}),
  onRemove: vi.fn(async () => {}),
  onRestore: vi.fn(async () => {}),
};

const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) });

describe('StandingTabView', () => {
  it('draws the standings as radios, the current one wearing Now, with its date', () => {
    render(<StandingTabView {...base} />);
    expect(radio('Active')).toBeChecked();
    expect(radio('Active')).toHaveAccessibleName(expect.stringContaining('Now'));
    expect(radio('Dormant')).not.toBeChecked();
    expect(radio('Removed')).not.toBeChecked();
    expect(screen.getByText('Since 17 Sep 2026')).toBeInTheDocument();
    // No form until another standing is picked.
    expect(document.querySelector('[data-slot="standing-form"]')).toBeNull();
  });

  it('draws what keeps it active as one lane per reason, each said in words', () => {
    render(<StandingTabView {...base} />);
    const lanes = screen.getAllByRole('listitem');
    expect(lanes.map((l) => l.textContent)).toEqual([
      'Map boost0.3 · 19 SepHolds',
      'Favorites9 skatersHolds',
      'Saved put-ins3 put-insHolds',
      'On the water10 Oct · a reportUntil the 1 Jul 2030 rollover',
    ]);
    expect(
      screen.getByText('Any one keeps it. The report alone holds through 2029–30.'),
    ).toBeVisible();
  });

  it('names what no read serves yet instead of drawing a zero', () => {
    render(<StandingTabView {...base} retention={MASCOMA_RETENTION_WIRED} />);
    expect(screen.queryByText(/Favorites/)).toBeNull();
    expect(screen.getByText('Not recorded yet: favorites and the last report.')).toBeVisible();
  });

  it('picking Dormant opens its form; the note counts and is sent trimmed', async () => {
    const onSetDormant = vi.fn(async () => {});
    render(<StandingTabView {...base} onSetDormant={onSetDormant} />);
    await userEvent.click(radio('Dormant'));
    const form = document.querySelector<HTMLElement>('[data-slot="standing-form"]');
    expect(form).not.toBeNull();
    const input = screen.getByRole('textbox', { name: 'Note for skaters · optional' });
    await userEvent.type(input, '  Dam work  ');
    expect(screen.getByText('12 / 160')).toBeVisible();
    await userEvent.type(input, '{Enter}');
    expect(onSetDormant).toHaveBeenCalledWith('Dam work');
  });

  it('Remove from the map waits, armed, until a reason is chosen', async () => {
    const onRemove = vi.fn(async () => {});
    render(<StandingTabView {...base} onRemove={onRemove} />);
    await userEvent.click(radio('Removed'));
    const remove = screen.getByRole('button', { name: 'Remove from the map' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('data-armed');
  });

  it('a write that fails says why and keeps the form', async () => {
    const onSetDormant = vi.fn(async () => {
      throw new Error('Only an active body can be set dormant');
    });
    render(<StandingTabView {...base} onSetDormant={onSetDormant} />);
    await userEvent.click(radio('Dormant'));
    await userEvent.click(screen.getByRole('button', { name: /Set dormant/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an active body can be set dormant',
    );
  });

  it('draws no control the viewer lacks: a moderator never sees Removed', () => {
    render(<StandingTabView {...base} canRemove={false} />);
    expect(screen.queryByRole('radio', { name: /^Removed/ })).toBeNull();
  });

  it('without body.standing the other standings are inert', () => {
    render(<StandingTabView {...base} canSetStanding={false} canRemove={false} />);
    expect(radio('Dormant')).toHaveAttribute('data-disabled');
  });

  it('a hand-set dormancy says since when and why, and offers the way back', async () => {
    const onSetActive = vi.fn(async () => {});
    render(<StandingTabView {...base} standing={DORMANT_BY_HAND} onSetActive={onSetActive} />);
    expect(radio('Dormant')).toBeChecked();
    expect(screen.getByText('Since 2 Oct 2026 · Moderator')).toBeVisible();
    expect(
      screen.getByText(
        'Skaters read “A moderator set this lake inactive: Drawn down for dam work until January”',
      ),
    ).toBeVisible();
    // Not active, so nothing keeps it active.
    expect(screen.queryByText('What keeps it active')).toBeNull();
    await userEvent.click(radio('Active'));
    await userEvent.click(screen.getByRole('button', { name: 'Bring back to the active map' }));
    expect(onSetActive).toHaveBeenCalled();
  });

  it('a dormancy on the access ruling is changed on Access, not here', () => {
    render(<StandingTabView {...base} standing={DORMANT_ON_RULING} />);
    expect(radio('Active')).toHaveAttribute('data-disabled');
    expect(screen.getByText('Dormant on the access ruling; it changes on Access.')).toBeVisible();
  });

  it('a removed body is restored, by an admin only', async () => {
    const onRestore = vi.fn(async () => {});
    const { unmount } = render(
      <StandingTabView {...base} standing={REMOVED} onRestore={onRestore} />,
    );
    expect(screen.getByText('Since 1 Oct 2026 · Landowner request')).toBeVisible();
    await userEvent.click(radio('Active'));
    await userEvent.click(screen.getByRole('button', { name: 'Restore to the map' }));
    expect(onRestore).toHaveBeenCalled();
    unmount();
    render(<StandingTabView {...base} standing={REMOVED} canRemove={false} />);
    // The current standing stays drawn; the way back is not offered.
    expect(radio('Removed')).toBeChecked();
    expect(radio('Active')).toHaveAttribute('data-disabled');
  });

  it('when the standing moves under it, the pick follows back to Now', async () => {
    const { rerender } = render(<StandingTabView {...base} />);
    await userEvent.click(radio('Dormant'));
    rerender(<StandingTabView {...base} standing={DORMANT_BY_HAND} />);
    expect(radio('Dormant')).toBeChecked();
    expect(document.querySelector('[data-slot="standing-form"]')).toBeNull();
  });

  it('an unlisted body has no standing to choose', () => {
    render(<StandingTabView {...base} standing={{ standing: 'unlisted' }} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(within(document.body).getByText(/Not on the map/)).toBeVisible();
  });
});

describe('laneFraction', () => {
  it('clamps to the axis and survives an empty one', () => {
    expect(laneFraction(5, 0, 10)).toBe(0.5);
    expect(laneFraction(-5, 0, 10)).toBe(0);
    expect(laneFraction(50, 0, 10)).toBe(1);
    expect(laneFraction(5, 10, 10)).toBe(0);
  });
});
