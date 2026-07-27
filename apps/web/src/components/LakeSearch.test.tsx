import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type LakeHit, LakeSearchBox } from './LakeSearch';

const HITS: LakeHit[] = [
  {
    kind: 'body',
    _id: 'a',
    waterBodyId: 'a',
    name: 'Lake George',
    type: 'lake',
    centroid: { lat: 43.6, lng: -73.5 },
    bbox: { minLat: 43.4, minLng: -73.7, maxLat: 43.8, maxLng: -73.3 },
    states: ['NY'],
  },
  {
    kind: 'body',
    _id: 'b',
    waterBodyId: 'b',
    name: 'Sebago Lake',
    type: 'reservoir',
    centroid: { lat: 43.8, lng: -70.5 },
    bbox: { minLat: 43.6, minLng: -70.7, maxLat: 44.0, maxLng: -70.3 },
    states: ['ME'],
  },
];

/** A named bay (N2/D60) — the row that has to say which lake it belongs to. */
const BAY_HIT: LakeHit = {
  kind: 'subArea',
  _id: 'sa1',
  waterBodyId: 'champlain',
  name: 'Malletts Bay',
  parentName: 'Lake Champlain',
  type: 'lake',
  centroid: { lat: 44.55, lng: -73.22 },
  bbox: { minLat: 44.5, minLng: -73.3, maxLat: 44.6, maxLng: -73.15 },
  states: ['VT'],
};

function renderBox(overrides: Partial<React.ComponentProps<typeof LakeSearchBox>> = {}) {
  const onSelect = vi.fn();
  const onInputValueChange = vi.fn();
  render(
    <LakeSearchBox
      items={HITS}
      inputValue="lake"
      onInputValueChange={onInputValueChange}
      onSelect={onSelect}
      emptyVisible={false}
      open
      {...overrides}
    />,
  );
  return { onSelect, onInputValueChange };
}

describe('LakeSearchBox', () => {
  it('renders result rows with a humanized type + state label', () => {
    renderBox();
    expect(screen.getByText('Lake George')).toBeInTheDocument();
    expect(screen.getByText('Sebago Lake')).toBeInTheDocument();
    expect(screen.getByText('Lake · NY')).toBeInTheDocument();
    expect(screen.getByText('Reservoir · ME')).toBeInTheDocument();
  });

  it('tells you which lake a named bay belongs to, not its (parent-inherited) type', () => {
    renderBox({ items: [...HITS, BAY_HIT] });
    expect(screen.getByText('Malletts Bay')).toBeInTheDocument();
    // "Lake · VT" would be the parent's type and tells you nothing you didn't just read; where the
    // bay *is* is the disambiguation people need when three lakes have a South Bay.
    expect(screen.getByText('in Lake Champlain')).toBeInTheDocument();
  });

  it('calls onSelect with the chosen hit when a result is clicked', () => {
    const { onSelect } = renderBox({ inputValue: 'george' });
    fireEvent.click(screen.getByRole('option', { name: /Lake George/ }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'a', name: 'Lake George' }),
    );
  });

  it('reports typing through onInputValueChange', () => {
    const { onInputValueChange } = renderBox({ items: [], inputValue: '', open: false });
    fireEvent.change(screen.getByLabelText('Search lakes by name'), { target: { value: 'morey' } });
    // Base UI passes (value, eventDetails); the container's setText ignores the second arg.
    expect(onInputValueChange.mock.calls[0]?.[0]).toBe('morey');
  });

  it('shows the empty state when emptyVisible', () => {
    renderBox({ items: [], inputValue: 'zzzz', emptyVisible: true });
    expect(screen.getByText('No lakes found.')).toBeInTheDocument();
  });
});
