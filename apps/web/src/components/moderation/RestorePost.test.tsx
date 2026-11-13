import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { describe, expect, test, vi } from 'vitest';
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
    expect(
      box.getByText(/Removed by @sarah on Jan 15, 2027 — Photo shows a license plate/),
    ).toBeInTheDocument();
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

  test("a refusal from the server is shown in the server's words", async () => {
    render(
      <RestorePostView
        choices={PLAIN}
        onRestore={async () => {
          throw new ConvexError(NEEDS_A_CHOICE);
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Restore post' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(NEEDS_A_CHOICE);
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
