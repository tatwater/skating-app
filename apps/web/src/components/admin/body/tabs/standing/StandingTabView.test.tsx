import { AUDIT_REASON_MAX } from '@skating/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { laneFraction } from '@/components/kit/lane-timeline';
import { StandingTabView, type StandingTabViewProps } from './StandingTabView';
import {
  ACTIVE,
  ACTIVE_SINCE,
  BODY_NOW,
  DORMANT_BY_HAND,
  DORMANT_ON_RULING,
  MASCOMA_RETENTION,
  REMOVED,
  RETENTION_PART_UNREAD,
} from './standingFixtures';

const base: StandingTabViewProps = {
  standing: ACTIVE,
  activeSince: ACTIVE_SINCE,
  retention: MASCOMA_RETENTION,
  now: BODY_NOW,
  canSetStanding: true,
  canRemove: true,
  onSetDormant: vi.fn(async () => true),
  onSetActive: vi.fn(async () => true),
  onRemove: vi.fn(async () => true),
  onRestore: vi.fn(async () => true),
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

  it('holds the retention note as Trying again… while it is tried again', () => {
    render(<StandingTabView {...base} retention="error" onRetry={vi.fn()} retryPending />);
    expect(screen.getByText('What keeps it active couldn’t be read')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeVisible();
  });

  it('keeps the retention note’s region mounted, and focus on it, when the fresh answer lands', async () => {
    const { rerender } = render(<StandingTabView {...base} retention="error" onRetry={vi.fn()} />);
    const region = screen
      .getByText('What keeps it active couldn’t be read')
      .closest('[role="status"]') as HTMLElement;
    await userEvent.click(within(region).getByRole('button', { name: 'Try again' }));
    rerender(<StandingTabView {...base} />);
    expect(region).toBeInTheDocument();
    expect(region).toHaveFocus();
    expect(
      screen.getByText('Any one keeps it. The report alone holds through 2029–30.'),
    ).toBeVisible();
  });

  it('names what no read serves yet instead of drawing a zero', () => {
    render(<StandingTabView {...base} retention={RETENTION_PART_UNREAD} />);
    expect(screen.queryByText(/Favorites/)).toBeNull();
    expect(screen.getByText('Not recorded yet: favorites and the last report.')).toBeVisible();
  });

  it('picking Dormant opens its form; the note counts and is sent trimmed', async () => {
    const onSetDormant = vi.fn(async () => true);
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

  it('a second ⏎ in the note while its write is on its way sends nothing more', async () => {
    let land: () => void = () => {};
    const onSetDormant = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          land = () => resolve(true);
        }),
    );
    render(<StandingTabView {...base} onSetDormant={onSetDormant} />);
    await userEvent.click(radio('Dormant'));
    const input = screen.getByRole('textbox', { name: 'Note for skaters · optional' });
    await userEvent.type(input, 'Dam work{Enter}{Enter}');
    expect(onSetDormant).toHaveBeenCalledTimes(1);
    land();
  });

  it('a sent note is held while its write is out — never typed into and then thrown away', async () => {
    let refuse: () => void = () => {};
    const onSetDormant = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          refuse = () => resolve(false);
        }),
    );
    render(<StandingTabView {...base} onSetDormant={onSetDormant} />);
    await userEvent.click(radio('Dormant'));
    const input = screen.getByRole('textbox', { name: 'Note for skaters · optional' });
    await userEvent.type(input, 'Dam work{Enter}');
    expect(input).toHaveAttribute('readonly');
    await userEvent.type(input, ' until May');
    expect(input).toHaveValue('Dam work');
    // Refused: said in its toast (the write path's); the form keeps the note and prints nothing.
    await act(async () => refuse());
    expect(input).not.toHaveAttribute('readonly');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.type(input, ' until May');
    expect(input).toHaveValue('Dam work until May');
  });

  it('a sent removal reason is held while its write is out', async () => {
    const onRemove = vi.fn(() => new Promise<boolean>(() => {}));
    render(<StandingTabView {...base} onRemove={onRemove} />);
    await userEvent.click(radio('Removed'));
    await userEvent.click(screen.getByRole('combobox', { name: 'Reason' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Not skateable' }));
    const remove = screen.getByRole('button', { name: 'Remove from the map' });
    await userEvent.click(remove);
    if (onRemove.mock.calls.length === 0) {
      await userEvent.click(screen.getByRole('button', { name: /again/ }));
    }
    expect(onRemove).toHaveBeenCalledWith('unskateable', '');
    expect(screen.getByRole('combobox', { name: 'Reason' })).toHaveAttribute('data-readonly');
  });

  it('a removal asks for a note too, held to the audit cap, and sends it trimmed beside the reason', async () => {
    const onRemove = vi.fn(async () => true);
    render(<StandingTabView {...base} onRemove={onRemove} />);
    await userEvent.click(radio('Removed'));
    await userEvent.click(screen.getByRole('combobox', { name: 'Reason' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Landowner request' }));
    const note = screen.getByRole('textbox', { name: 'Note · optional' });
    // The server's own cap (D261), never a copy of its number.
    expect(note).toHaveAttribute('maxLength', String(AUDIT_REASON_MAX));
    await userEvent.type(note, '  The owner called on 3 Nov  ');
    await userEvent.click(screen.getByRole('button', { name: 'Remove from the map' }));
    expect(onRemove).toHaveBeenCalledWith('landowner_request', 'The owner called on 3 Nov');
  });

  it('a note typed for one standing never carries into another’s form', async () => {
    render(<StandingTabView {...base} />);
    await userEvent.click(radio('Dormant'));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Note for skaters · optional' }),
      'Dam work',
    );
    await userEvent.click(radio('Removed'));
    expect(screen.getByRole('textbox', { name: 'Note · optional' })).toHaveValue('');
    await userEvent.click(radio('Dormant'));
    expect(screen.getByRole('textbox', { name: 'Note for skaters · optional' })).toHaveValue('');
  });

  it('a pick moved while a write is out sends nothing more until that write answers', async () => {
    let land: () => void = () => {};
    const onSetDormant = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          land = () => resolve(true);
        }),
    );
    const onRemove = vi.fn(async () => true);
    render(<StandingTabView {...base} onSetDormant={onSetDormant} onRemove={onRemove} />);
    await userEvent.click(radio('Dormant'));
    await userEvent.click(screen.getByRole('button', { name: /Set dormant/ }));
    expect(onSetDormant).toHaveBeenCalledTimes(1);
    // The pick moves to Removed while the dormant write is out: the form is the same one, still
    // busy — its reason held, its note read-only — so no second write can start beside the first.
    await userEvent.click(radio('Removed'));
    expect(screen.getByRole('combobox', { name: 'Reason' })).toHaveAttribute('data-readonly');
    expect(screen.getByRole('textbox', { name: 'Note · optional' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'Note · optional' })).toHaveValue('');
    await act(async () => land());
    expect(screen.getByRole('combobox', { name: 'Reason' })).not.toHaveAttribute('data-readonly');
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('a sent removal note is held while its write is out, and kept when it is refused', async () => {
    let refuse: () => void = () => {};
    const onRemove = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          refuse = () => resolve(false);
        }),
    );
    render(<StandingTabView {...base} onRemove={onRemove} />);
    await userEvent.click(radio('Removed'));
    await userEvent.click(screen.getByRole('combobox', { name: 'Reason' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Not skateable' }));
    const note = screen.getByRole('textbox', { name: 'Note · optional' });
    await userEvent.type(note, 'Drained');
    await userEvent.click(screen.getByRole('button', { name: 'Remove from the map' }));
    expect(note).toHaveAttribute('readonly');
    await act(async () => refuse());
    expect(note).not.toHaveAttribute('readonly');
    expect(note).toHaveValue('Drained');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Remove from the map waits, armed, until a reason is chosen', async () => {
    const onRemove = vi.fn(async () => true);
    render(<StandingTabView {...base} onRemove={onRemove} />);
    await userEvent.click(radio('Removed'));
    const remove = screen.getByRole('button', { name: 'Remove from the map' });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute('data-armed');
  });

  it.each([
    ['refused', async () => false],
    [
      'a sender that threw',
      async () => {
        throw new Error('x');
      },
    ],
  ])('a write %s keeps the form and its note, and prints nothing', async (_, answer) => {
    const onSetDormant = vi.fn(answer);
    render(<StandingTabView {...base} onSetDormant={onSetDormant} />);
    await userEvent.click(radio('Dormant'));
    const input = screen.getByRole('textbox', { name: 'Note for skaters · optional' });
    await userEvent.type(input, 'Dam work');
    await userEvent.click(screen.getByRole('button', { name: /Set dormant/ }));
    await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
    expect(onSetDormant).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('Dam work');
    expect(screen.queryByRole('alert')).toBeNull();
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
    const onSetActive = vi.fn(async () => true);
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
    const onRestore = vi.fn(async () => true);
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
