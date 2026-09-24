import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BayRequestQueue, type BayRequestRow } from './BayRequestQueue';

const ROW: BayRequestRow = {
  requestId: 'req1',
  name: 'Northwest Bay',
  aliases: ['NW Bay', 'North West Bay'],
  coord: { lat: 44.185, lng: -73.417 },
  notes: ['Corpus: 26 messages, 12 skated.'],
  askers: 2,
  createdAt: Date.parse('2026-09-21T00:00:00Z'),
};

describe('BayRequestQueue (D201)', () => {
  it('renders nothing when nobody has asked', () => {
    const { container } = render(
      <BayRequestQueue
        rows={[]}
        onDraw={() => {}}
        onApprove={async () => {}}
        onDecline={async () => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each bay with its askers, aliases and notes, and hands a row to the chord tool', async () => {
    const onDraw = vi.fn();
    render(
      <BayRequestQueue
        rows={[ROW]}
        onDraw={onDraw}
        onApprove={async () => {}}
        onDecline={async () => {}}
      />,
    );
    expect(screen.getByText('Northwest Bay')).toBeInTheDocument();
    expect(screen.getByText('2 people')).toBeInTheDocument();
    expect(screen.getByText(/NW Bay, North West Bay/)).toBeInTheDocument();
    expect(screen.getByText(/26 messages/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Draw' }));
    expect(onDraw).toHaveBeenCalledWith(ROW);
  });

  it('offers Approve instead of Draw once a bay by that name exists', async () => {
    const onApprove = vi.fn(async () => {});
    render(
      <BayRequestQueue
        rows={[{ ...ROW, drawnSubAreaId: 'sa1' }]}
        onDraw={() => {}}
        onApprove={onApprove}
        onDecline={async () => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Draw' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalled();
  });

  it('says a row is being drawn rather than offering it twice', () => {
    render(
      <BayRequestQueue
        rows={[ROW]}
        busy="req1"
        onDraw={() => {}}
        onApprove={async () => {}}
        onDecline={async () => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Draw' })).not.toBeInTheDocument();
    expect(screen.getByText(/drawing…/)).toBeInTheDocument();
  });

  it('declines with a note the skater reads — never without one', async () => {
    const onDecline = vi.fn(async () => {});
    render(
      <BayRequestQueue
        rows={[ROW]}
        onDraw={() => {}}
        onApprove={async () => {}}
        onDecline={onDecline}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Not a bay' }));
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecline).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole('textbox'), 'A landmark, not a destination.');
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onDecline).toHaveBeenCalledWith(ROW, 'A landmark, not a destination.');
  });
});
