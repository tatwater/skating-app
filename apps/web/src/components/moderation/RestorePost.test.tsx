import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { Refused } from '../admin/said';
import { RestorePostView } from './RestorePost';
import { id, MIXED, NEEDS_A_CHOICE, NOTHING, PLAIN } from './restorePostFixtures';

const dialog = () => screen.queryByRole('dialog');

describe('RestorePostView', () => {
  test('a plain restore that brings a Report back restores at once, with no chooser', async () => {
    const onRestore = vi.fn(async () => {});
    render(<RestorePostView choices={PLAIN} onRestore={onRestore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore post' }));
    expect(onRestore).toHaveBeenCalledWith([]);
    expect(dialog()).toBeNull();
  });

  test('otherwise a checklist opens with nothing chosen; the confirm counts what is ticked', async () => {
    const onRestore = vi.fn(async () => {});
    render(<RestorePostView choices={MIXED} onRestore={onRestore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore post' }));
    const box = within(await waitFor(() => dialog() ?? Promise.reject(new Error('closed'))));

    const checks = box.getAllByRole('checkbox');
    expect(checks).toHaveLength(3);
    for (const c of checks) expect(c).not.toBeChecked();
    // What each is and why it is down, the author's withdrawal shown but not choosable.
    expect(box.getByText('Lake Fairlee · Jan 13, 2027')).toBeInTheDocument();
    // Who took it down by their real name, masked from analytics as every name is — never a handle.
    const why = box
      .getAllByText(/Removed by/)
      .find((e) => e.textContent?.includes('Photo shows a license plate')) as HTMLElement;
    expect(why).toHaveTextContent(
      'Removed by Sarah Berman on Jan 15, 2027 — Photo shows a license plate',
    );
    expect(why).not.toHaveTextContent('@sarah');
    expect(within(why).getByText('Sarah Berman')).toHaveClass('ph-no-capture');
    expect(box.getByText(/Deleted by its author on Jan 13, 2027/)).toBeInTheDocument();
    expect(checks[2]).toHaveAttribute('aria-disabled', 'true');

    const confirm = box.getByRole('button', { name: 'Restore with 0 reports' });
    expect(confirm).toBeDisabled();
    await userEvent.click(checks[1] as HTMLElement);
    await userEvent.click(box.getByRole('button', { name: 'Restore with 1 report' }));
    expect(onRestore).toHaveBeenCalledWith([id('r_removed')]);
  });

  test('when every Report was deleted by its author, it says so and offers no restore', async () => {
    const onRestore = vi.fn(async () => {});
    render(<RestorePostView choices={NOTHING} onRestore={onRestore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore post' }));
    const box = within(await waitFor(() => dialog() ?? Promise.reject(new Error('closed'))));
    expect(box.getByText(/so the post can't be restored/)).toBeInTheDocument();
    for (const c of box.getAllByRole('checkbox'))
      expect(c).toHaveAttribute('aria-disabled', 'true');
    expect(box.queryByRole('button', { name: /Restore with/ })).toBeNull();
    expect(box.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(onRestore).not.toHaveBeenCalled();
  });

  test('a refusal is its write’s toast (the net): the view prints nothing, and its button is back', async () => {
    const onRestore = vi.fn(async () => {
      throw new Refused();
    });
    render(<RestorePostView choices={PLAIN} onRestore={onRestore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore post' }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore post' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(NEEDS_A_CHOICE)).toBeNull();
  });

  test('a ticked Report that leaves the list leaves the choice and the count', async () => {
    const onRestore = vi.fn(async () => {});
    const { rerender } = render(<RestorePostView choices={MIXED} onRestore={onRestore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Restore post' }));
    const box = within(await waitFor(() => dialog() ?? Promise.reject(new Error('closed'))));
    const [hidden, removed] = box.getAllByRole('checkbox') as [HTMLElement, HTMLElement];
    await userEvent.click(hidden);
    await userEvent.click(removed);
    expect(box.getByRole('button', { name: 'Restore with 2 reports' })).toBeEnabled();

    // Someone else restored the hidden one on its own: it is visible now, and off the list.
    const members = MIXED.members.map((m) =>
      m.reportId === id('r_hidden')
        ? { ...m, status: 'visible' as const, standing: 'visible' as const }
        : m,
    );
    rerender(<RestorePostView choices={{ ...MIXED, members }} onRestore={onRestore} />);
    await userEvent.click(box.getByRole('button', { name: 'Restore with 1 report' }));
    expect(onRestore).toHaveBeenCalledWith([id('r_removed')]);
  });

  test('a Post that is up already offers no restore', () => {
    render(<RestorePostView choices={{ ...PLAIN, postStatus: 'visible' }} onRestore={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Restore post' })).toBeDisabled();
  });
});
