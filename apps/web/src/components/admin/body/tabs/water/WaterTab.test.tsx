import { render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Body › Water as the console mounts it: the record, read-only until its writes exist. */

const mocks = vi.hoisted(() => ({ results: new Map<string, unknown>() }));

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server');
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
      mocks.results.get(getFunctionName(ref)),
  };
});

import { api } from '@skating/convex/api';
import { getFunctionName } from 'convex/server';

import { stubJsdomAnimations } from '../jsdomStubs';
import { WaterTab } from './WaterTab';

beforeAll(stubJsdomAnimations);

beforeEach(() => {
  mocks.results.clear();
});

describe('WaterTab', () => {
  it('draws the record’s depth and point, with no control and no bathymetry guessed', () => {
    mocks.results.set(getFunctionName(api.waterBodies.get), {
      available: true,
      body: {
        _id: 'wb1',
        name: 'Mascoma Lake',
        states: ['NH'],
        meanDepthM: 9.4,
        maxDepthM: 24,
        meanDepthSource: 'state_agency',
        maxDepthSource: 'state_agency',
        interiorPoint: { lat: 43.617368, lng: -72.136006 },
        bbox: { maxLat: 43.6497901, maxLng: -72.1206902, minLat: 43.6061979, minLng: -72.1819521 },
      },
    });
    render(<WaterTab bodyId="wb1" />);
    expect(screen.getByText('NH state survey')).toBeTruthy();
    expect(screen.getByText('43.6174°N 72.1360°W')).toBeTruthy();
    expect(screen.getByText('Not recorded yet')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('holds its place while the record loads', () => {
    const { container } = render(<WaterTab bodyId="wb1" />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
});
