import type { SheetLandmark, Where } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { SheetBody } from './useSheetBody';
import { whereClickOnWater } from './WhereCards';
import { WherePicker } from './WherePicker';

function lm(name: string, prominence: number, extra: Partial<SheetLandmark> = {}): SheetLandmark {
  return {
    _id: `id-${name}`,
    name,
    kind: 'island',
    point: { lat: 44.5, lng: -73.3 },
    aliases: [],
    prominence,
    ...extra,
  };
}

// Ten landmarks: the eight most prominent are chips, two wait behind the search.
const LANDMARKS = [
  lm('Apple Island', 9),
  ...Array.from({ length: 7 }, (_, i) => lm(`Rock ${i}`, 5)),
  lm('Cedar Island', 1, { aliases: ['Cedar Is'] }),
  lm('Gull Ledge', 1, { point: { lat: 44.6, lng: -73.4 } }),
];

const body: SheetBody = {
  waterBodyId: 'wb1',
  name: 'Lake Champlain',
  polygon: null,
  silhouette: null,
  frame: null,
  bays: [],
  landmarks: LANDMARKS,
  putIns: [],
  parking: [],
  hazards: [],
  recentCards: [],
  sunAt: () => null,
  timeZone: 'America/New_York',
};

function Harness({ initial }: { initial?: Where }) {
  const [where, setWhere] = useState<Where | undefined>(initial);
  return (
    <>
      <WherePicker where={where} body={body} onChange={setWhere} />
      <output data-testid="where">{JSON.stringify(where ?? null)}</output>
    </>
  );
}

const whereNow = () =>
  JSON.parse(screen.getByTestId('where').textContent ?? 'null') as Where | null;

describe('WherePicker landmarks (D202)', () => {
  it('offers the most prominent as chips, and the rest behind a search', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Apple Island' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cedar Island' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '2 more places…' }));
    fireEvent.change(screen.getByLabelText('Find a place on the lake'), {
      target: { value: 'cedar is' },
    });
    expect(screen.getByRole('button', { name: 'Cedar Island' })).toBeInTheDocument();
  });

  it('choosing a landmark is choosing its point, name and id; choosing it again clears it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Apple Island' }));
    expect(whereNow()?.point).toEqual({
      coord: { lat: 44.5, lng: -73.3 },
      radiusMeters: 75,
      name: 'Apple Island',
      landmarkId: 'id-Apple Island',
    });
    expect(screen.getByText('Near Apple Island')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apple Island' }));
    expect(whereNow()).toBeNull();
  });

  it('a tapped spot no landmark answers to can be named, and says the name will be proposed', () => {
    render(<Harness initial={{ point: { coord: { lat: 44.0, lng: -73.0 }, radiusMeters: 75 } }} />);
    fireEvent.change(screen.getByLabelText('Name this spot'), {
      target: { value: 'Bird Poop Rock' },
    });
    expect(whereNow()?.point).toEqual({
      coord: { lat: 44.0, lng: -73.0 },
      radiusMeters: 75,
      name: 'Bird Poop Rock',
    });
    expect(screen.getByText(/suggest “Bird Poop Rock” to the moderators/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name this spot'), { target: { value: '' } });
    expect(whereNow()?.point?.name).toBeUndefined();
  });

  it('a landmark’s own point offers no name field — it has one', () => {
    render(
      <Harness
        initial={{
          point: {
            coord: { lat: 44.5, lng: -73.3 },
            radiusMeters: 75,
            name: 'Apple Island',
            landmarkId: 'id-Apple Island',
          },
        }}
      />,
    );
    expect(screen.queryByLabelText('Name this spot')).toBeNull();
  });
});

describe('whereClickOnWater', () => {
  it('names a click near a landmark for it, and leaves a click in open water a bare point', () => {
    expect(whereClickOnWater({ sector: 'N' }, { lat: 44.6003, lng: -73.4 }, LANDMARKS)).toEqual({
      sector: 'N',
      point: {
        coord: { lat: 44.6003, lng: -73.4 },
        radiusMeters: 75,
        name: 'Gull Ledge',
        landmarkId: 'id-Gull Ledge',
      },
    });
    expect(whereClickOnWater(undefined, { lat: 44.0, lng: -73.0 })).toEqual({
      point: { coord: { lat: 44.0, lng: -73.0 }, radiusMeters: 75 },
    });
  });
});

describe('a tap that took a landmark’s name', () => {
  it('can be let go of, and named something else', () => {
    render(
      <Harness
        initial={{
          point: {
            coord: { lat: 44.6003, lng: -73.4 },
            radiusMeters: 75,
            name: 'Gull Ledge',
            landmarkId: 'id-Gull Ledge',
          },
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Not Gull Ledge — name this spot' }));
    expect(whereNow()?.point).toEqual({ coord: { lat: 44.6003, lng: -73.4 }, radiusMeters: 75 });
    expect(screen.getByLabelText('Name this spot')).toBeInTheDocument();
  });
});
