import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { convexReact, fakes, resetFakes } from '../testMocks';

vi.mock('convex/react', () => convexReact);

import { FLAG_REASONS, FlagDialog, FlagDialogView } from './FlagDialog';

beforeEach(resetFakes);

describe('FlagDialog', () => {
  it('leads with the safety reason', () => {
    expect(FLAG_REASONS[0]?.value).toBe('unsafe_false_report');
  });

  it('asks for a reason, sends it with the note, then thanks', async () => {
    render(<FlagDialog target="report" targetId="r1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Flag' }));
    expect(await screen.findByText('Flag this report')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'Spam' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Note (optional)' }),
      ' same post three times ',
    );
    await userEvent.click(send);
    expect(fakes.mutations.get('contentFlags:flag')).toHaveBeenCalledWith({
      targetType: 'report',
      targetId: 'r1',
      reason: 'spam',
      note: 'same post three times',
    });
    expect(await screen.findByText('Thanks. A moderator will review it.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  });

  it('sends no note when there is none, and says when it didn’t send', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    render(<FlagDialogView target="comment" label="Flag" size="xs" onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Flag' }));
    await userEvent.click(
      await screen.findByRole('radio', { name: 'Dangerously false ice report' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith('unsafe_false_report', undefined);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not sent.');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Reopened, it starts over.
    await userEvent.click(screen.getByRole('button', { name: 'Flag' }));
    expect(await screen.findByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
