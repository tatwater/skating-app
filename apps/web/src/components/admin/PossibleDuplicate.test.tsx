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
      <PossibleDuplicate lookalikes={{}} onShow={vi.fn()} onSamePlace={vi.fn(async () => {})} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the landmark and the other proposal, shows each pair, and answers with the landmark', async () => {
    const onShow = vi.fn();
    const onSamePlace = vi.fn(async () => {});
    render(
      <PossibleDuplicate
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
    expect(onShow).toHaveBeenLastCalledWith('landmark');
    fireEvent.click(showProposal as HTMLElement);
    expect(onShow).toHaveBeenLastCalledWith('proposal');
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
        lookalikes={{ similarLandmark: landmark }}
        busy
        onShow={vi.fn()}
        onSamePlace={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByRole('button', { name: 'Same place' })).toBeDisabled();
  });
});

describe('Same place, while the row moves under it (Greptile P1 on #88)', () => {
  const nearer = {
    landmarkId: 'lm2' as Id<'bodyLandmarks'>,
    name: 'Long Point',
    point: { lat: 44.505, lng: -73.3 },
    meters: 560,
  };

  it('answers the landmark the open dialog named, never one that arrived after', async () => {
    const onSamePlace = vi.fn(async () => {});
    const view = (similarLandmark: typeof landmark) => (
      <PossibleDuplicate
        lookalikes={{ similarLandmark }}
        onShow={vi.fn()}
        onSamePlace={onSamePlace}
      />
    );
    const { rerender } = render(view(landmark));
    await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('2.1 mi away');
    // A colleague adds a nearer Long Point: the row's lookalike changes; the dialog does not.
    rerender(view(nearer));
    expect(screen.getByRole('dialog')).toHaveTextContent('2.1 mi away');
    await userEvent.click(screen.getByRole('button', { name: 'Answer with this landmark' }));
    expect(onSamePlace).toHaveBeenCalledWith('lm1', '');
    // Closed, the next dialog is about the row as it stands.
    await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('0.3 mi away');
  });

  it('holds an open confirm when the row locks, and a stale row only from opening a new one', async () => {
    const view = (props: { busy?: boolean; stale?: boolean }) => (
      <PossibleDuplicate
        lookalikes={{ similarLandmark: landmark }}
        {...props}
        onShow={vi.fn()}
        onSamePlace={vi.fn(async () => {})}
      />
    );
    const { rerender } = render(view({}));
    await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
    rerender(view({ stale: true }));
    expect(screen.getByRole('button', { name: 'Answer with this landmark' })).toBeEnabled();
    rerender(view({ busy: true }));
    expect(screen.getByRole('button', { name: 'Answer with this landmark' })).toBeDisabled();
  });

  it('holds the confirm when the landmark it names moves or is renamed under it', async () => {
    const view = (similarLandmark: typeof landmark) => (
      <PossibleDuplicate
        lookalikes={{ similarLandmark }}
        onShow={vi.fn()}
        onSamePlace={vi.fn(async () => {})}
      />
    );
    const { rerender } = render(view(landmark));
    await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
    const confirm = () => screen.getByRole('button', { name: 'Answer with this landmark' });
    expect(confirm()).toBeEnabled();
    // A colleague moves it miles off: the dialog still reads 2.1 mi, so the answer waits, and says why.
    rerender(view({ ...landmark, point: { lat: 44.7, lng: -73.3 }, meters: 22_240 }));
    expect(screen.getByRole('dialog')).toHaveTextContent('2.1 mi away');
    expect(screen.getByRole('dialog')).toHaveTextContent(/moved or renamed since you opened this/);
    expect(confirm()).toBeDisabled();
    // Renamed in place, the same.
    rerender(view({ ...landmark, name: 'Long Pt' }));
    expect(confirm()).toBeDisabled();
    rerender(view(landmark));
    expect(confirm()).toBeEnabled();
  });

  it('never carries a note drafted for one landmark into the answer for another', async () => {
    const onSamePlace = vi.fn(async () => {});
    const view = (similarLandmark: typeof landmark) => (
      <PossibleDuplicate
        lookalikes={{ similarLandmark }}
        onShow={vi.fn()}
        onSamePlace={onSamePlace}
      />
    );
    const { rerender } = render(view(landmark));
    await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
    await userEvent.type(screen.getByRole('textbox'), 'The causeway end.');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    rerender(view(nearer));
    await userEvent.click(screen.getByRole('button', { name: 'Same place' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('does not open for a stale row', () => {
    render(
      <PossibleDuplicate
        lookalikes={{ similarLandmark: landmark }}
        stale
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
