/**
 * The dedup merge card (D36 queue, rebuilt for the N7 corpus).
 *
 * What these pin is that the card cannot be *mistaken for another card*, which is the failure it
 * exists to fix: the queue arrived holding pairs of unnamed OSM features, both ends of every pair,
 * rendered as blank boxes above a button reading `Merge →`. So: an unnamed body is labelled as one,
 * the fields that disagree are the ones on screen, and the expensive half of the payload is not
 * fetched until somebody asks for it.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useQueryMock = vi.fn();
vi.mock('convex/react', () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));

import {
  type DuplicateGroup,
  DuplicateGroupCard,
  type DuplicateMember,
} from './DuplicateGroupCard';

function member(overrides: Partial<DuplicateMember> = {}): DuplicateMember {
  return {
    _id: 'a' as DuplicateMember['_id'],
    name: '',
    type: 'lakePond',
    source: 'osm',
    centroid: { lat: 43.7, lng: -71.2 },
    bbox: { minLat: 43.69, minLng: -71.21, maxLat: 43.71, maxLng: -71.19 },
    dedupStatus: 'near_certain',
    createdAt: Date.UTC(2026, 7, 1),
    ...overrides,
  };
}

function group(members: DuplicateMember[]): DuplicateGroup {
  return { key: members.map((m) => m._id).join('+'), members, truncated: false };
}

const noop = async () => undefined;

describe('DuplicateGroupCard', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue(undefined);
  });

  it('names an unnamed body instead of rendering an empty heading', () => {
    render(
      <DuplicateGroupCard
        group={group([
          member({ _id: 'a' as DuplicateMember['_id'], osmId: 'way/46908853' }),
          member({ _id: 'b' as DuplicateMember['_id'], osmId: 'relation/13068809' }),
        ])}
        onMerge={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getAllByText(/\(unnamed\)/).length).toBeGreaterThan(0);
  });

  it('shows the fields that disagree and hides the ones that do not', () => {
    render(
      <DuplicateGroupCard
        group={group([
          member({ _id: 'a' as DuplicateMember['_id'], osmId: 'way/46908853', nhdId: '141034051' }),
          member({ _id: 'b' as DuplicateMember['_id'], osmId: 'relation/13068809' }),
        ])}
        onMerge={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText('OSM id')).toBeInTheDocument();
    expect(screen.getByText('NHD id')).toBeInTheDocument();
    // Both are `lakePond` from `osm`, so neither row is worth an operator's attention.
    expect(screen.queryByText('Class')).not.toBeInTheDocument();
    expect(screen.getByText(/2 fields differ/)).toBeInTheDocument();
  });

  it('offers a survivor button per body, plus a way to say they are not duplicates', () => {
    render(
      <DuplicateGroupCard
        group={group([
          member({ _id: 'a' as DuplicateMember['_id'], name: 'Duncan Lake' }),
          member({ _id: 'b' as DuplicateMember['_id'], name: 'Duncan Lake' }),
        ])}
        onMerge={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getAllByRole('button', { name: /Keep Duncan Lake/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Not duplicates' })).toBeInTheDocument();
  });

  it('does not fetch outlines until they are asked for', async () => {
    render(
      <DuplicateGroupCard
        group={group([
          member({ _id: 'a' as DuplicateMember['_id'] }),
          member({ _id: 'b' as DuplicateMember['_id'] }),
        ])}
        onMerge={noop}
        onDismiss={noop}
      />,
    );
    expect(useQueryMock).toHaveBeenCalledWith(expect.anything(), 'skip');

    await userEvent.click(screen.getByRole('button', { name: /Outlines/ }));
    expect(useQueryMock).toHaveBeenCalledWith(expect.anything(), {
      waterBodyIds: ['a', 'b'],
    });
  });

  it('draws both outlines once the detail arrives, and never claims a verdict', async () => {
    const poly = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [-71.2, 43.7],
          [-71.19, 43.7],
          [-71.19, 43.71],
          [-71.2, 43.71],
          [-71.2, 43.7],
        ],
      ],
    };
    useQueryMock.mockReturnValue({
      members: [
        {
          _id: 'a',
          polygon: poly,
          vertices: 5,
          attachments: { reports: { n: 3, atLeast: false } },
        },
        {
          _id: 'b',
          polygon: poly,
          vertices: 5,
          attachments: { reports: { n: 0, atLeast: false } },
        },
      ],
      pairs: [{ aId: 'a', bId: 'b', iou: 0.97, centroidDistanceM: 8, areaRatio: 1.001 }],
    });

    render(
      <DuplicateGroupCard
        group={group([
          member({ _id: 'a' as DuplicateMember['_id'] }),
          member({ _id: 'b' as DuplicateMember['_id'] }),
        ])}
        onMerge={noop}
        onDismiss={noop}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Outlines/ }));

    expect(screen.getByRole('img', { name: /Outlines of 2 bodies/ })).toBeInTheDocument();
    expect(screen.getByText(/97% overlap/)).toBeInTheDocument();
    // The overlap is evidence for a person, never the machine grading its own homework.
    expect(screen.queryByText(/is a duplicate/i)).not.toBeInTheDocument();
    // The attachment counts say which row the community has been using.
    expect(screen.getByText('Reports')).toBeInTheDocument();
  });

  it('says so when a flag has lost the body it was flagged against', () => {
    render(
      <DuplicateGroupCard
        group={group([member({ _id: 'a' as DuplicateMember['_id'] })])}
        onMerge={noop}
        onDismiss={noop}
      />,
    );
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Keep/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not duplicates' })).toBeInTheDocument();
  });
});
