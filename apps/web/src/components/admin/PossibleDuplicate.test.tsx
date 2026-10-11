import type { Id } from '@skating/convex/dataModel';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GoogleMapsLink, PossibleDuplicate } from './PossibleDuplicate';

const ask = { lat: 44.5, lng: -73.3 };
const landmark = {
  landmarkId: 'lm1' as Id<'bodyLandmarks'>,
  name: 'Long Point',
  point: { lat: 44.53, lng: -73.3 },
  meters: 3_336,
};
const proposal = {
  requestId: 'req2' as Id<'waterBodyRequests'>,
  name: 'long point',
  coord: { lat: 44.6, lng: -73.3 },
  meters: 11_120,
};

describe('PossibleDuplicate', () => {
  it('says nothing when nothing shares the name elsewhere', () => {
    const { container } = render(
      <PossibleDuplicate
        ask={ask}
        name="Long Point"
        lookalikes={{}}
        onShow={vi.fn()}
        onSamePlace={vi.fn(async () => {})}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the landmark and the other proposal, shows each pair, and answers with the landmark', async () => {
    const onShow = vi.fn();
    const onSamePlace = vi.fn(async () => {});
    render(
      <PossibleDuplicate
        ask={ask}
        name="Long Point"
        lookalikes={{ similarLandmark: landmark, similarProposal: proposal }}
        onShow={onShow}
        onSamePlace={onSamePlace}
      />,
    );
    expect(screen.getByText('Possible duplicate')).toBeInTheDocument();
    expect(
      screen.getByText(/“Long Point” is already a landmark, 2\.1 mi from this spot/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Another “long point” proposal is 6\.9 mi away/)).toBeInTheDocument();
    const [showLandmark, showProposal] = screen.getAllByRole('button', { name: 'Show both' });
    fireEvent.click(showLandmark as HTMLElement);
    expect(onShow).toHaveBeenLastCalledWith({
      ask,
      name: 'Long Point',
      other: { point: landmark.point, kind: 'landmark', name: 'Long Point' },
    });
    fireEvent.click(showProposal as HTMLElement);
    expect(onShow).toHaveBeenLastCalledWith({
      ask,
      name: 'Long Point',
      other: { point: proposal.coord, kind: 'proposal', name: 'long point' },
    });
    // Confirmed first: it can answer with a landmark miles away, and nothing undoes it.
    await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
    expect(onSamePlace).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole('textbox'), 'The causeway end.');
    await userEvent.click(screen.getByRole('button', { name: 'Answer with this landmark' }));
    expect(onSamePlace).toHaveBeenCalledWith('lm1', 'The causeway end.');
  });

  it('holds Same place while a write is in flight', () => {
    render(
      <PossibleDuplicate
        ask={ask}
        name="Long Point"
        lookalikes={{ similarLandmark: landmark }}
        busy
        onShow={vi.fn()}
        onSamePlace={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByRole('button', { name: 'Same place' })).toBeDisabled();
  });
});

describe('GoogleMapsLink', () => {
  it('shows the coordinate and opens it in a new tab', () => {
    render(<GoogleMapsLink coord={ask} />);
    const link = screen.getByRole('link', { name: /44\.5000, -73\.3000/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).toContain('query=44.500000%2C-73.300000');
  });
});
