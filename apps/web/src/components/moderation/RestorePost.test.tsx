import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { RestorePostView } from './RestorePost';
import { id, MIXED, NOTHING, PLAIN } from './restorePostFixtures';

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
          throw new Error('refused');
        }}
        error="Every report in this post was hidden or removed on its own. Choose at least one report to restore with it."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Choose at least one report/);
  });
});
