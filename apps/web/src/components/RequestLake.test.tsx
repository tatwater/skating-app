import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestButtonsView } from './RequestLake';

describe('RequestButtonsView (N7b PR 2)', () => {
  it('offers exactly the kinds it is given, with the asker count beside a button', () => {
    const onAsk = vi.fn();
    render(
      <RequestButtonsView
        kinds={['activate', 'takedown']}
        outcome={null}
        counts={{ activate: 3 }}
        onAsk={onAsk}
      />,
    );
    const back = screen.getByRole('button', { name: /ask for this lake back/i });
    expect(back).toHaveTextContent('3');
    fireEvent.click(back);
    expect(onAsk).toHaveBeenCalledWith('activate');
    expect(screen.getByRole('button', { name: /take it off the map/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });

  it('says the ask is with the moderators and disables that button while it is open', () => {
    render(
      <RequestButtonsView
        kinds={['activate', 'takedown']}
        pendingKind="activate"
        outcome={null}
        counts={{}}
        onAsk={() => {}}
      />,
    );
    expect(screen.getByText(/with the moderators/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask for this lake back/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /take it off the map/i })).toBeEnabled();
  });

  it('reads the moderator’s answer back once there is one', () => {
    render(
      <RequestButtonsView
        kinds={['restore']}
        outcome="A moderator reviewed your request and left things as they are. Drained since 2024."
        counts={{}}
        onAsk={() => {}}
      />,
    );
    expect(screen.getByText(/Drained since 2024/)).toBeInTheDocument();
  });
});
