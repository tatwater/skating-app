import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// `AccessPhotos` is a child of this section and fetches its own rows. Stubbed at the Convex boundary
// rather than at the component, so the section renders exactly the tree it renders in the app.
vi.mock('convex/react', () => ({
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
}));

const { AccessSectionView } = await import('./AccessSection');

type Access = Parameters<typeof AccessSectionView>[0]['access'];
type PutIn = Access['putIns'][number];
type Parking = Access['parking'][number];
type Alert = Access['alerts'][number];

/** Branded Convex ids are opaque at the type level and meaningless in a render test. */
const id = <T,>(value: string): T => value as T;

const LOT = {
  id: id<Parking['id']>('lot1'),
  coord: { lat: 44, lng: -72 },
  name: 'Trailhead Lot',
  source: 'osm',
  amenities: [],
} as Parking;

const LAUNCH = {
  id: id<PutIn['id']>('p1'),
  coord: { lat: 44.01, lng: -72 },
  name: 'North launch',
  source: 'osm',
  parkingAreaId: id<PutIn['parkingAreaId']>('lot1'),
  approachMeters: 1_100,
  approachAscentM: 90,
  approachRouted: true,
  approachKindOverride: undefined,
} as PutIn;

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: id<Alert['id']>('a1'),
    reason: 'gate_locked',
    official: false,
    putInId: id<PutIn['id']>('p1'),
    ...over,
  } as Alert;
}

function access(over: Partial<Access> = {}): Access {
  return { putIns: [LAUNCH], parking: [LOT], blockedIds: [], alerts: [], ...over } as Access;
}

function renderView(data: Access) {
  return render(
    <AccessSectionView
      access={data}
      onVote={async () => undefined}
      onCreateAlert={async () => undefined}
    />,
  );
}

describe('AccessSectionView (N6d / D72, D73, D87)', () => {
  /**
   * The routing rule, which is the bug the whole phase exists to fix: for a hike-in pond we were
   * handing a maps app the *launch* coordinate, a destination it cannot route a car to, and the
   * skater found out at the trailhead.
   */
  it('sends you to the parking and then describes the walk', () => {
    renderView(access());
    expect(screen.getByText(/Park at Trailhead Lot, then put in at North launch/)).toBeVisible();
    // "about", not "at least" — this leg was routed, so the number is an estimate and not a floor.
    expect(screen.getByText(/^Park here, then about/)).toBeVisible();
    expect(screen.getByText('Hike-in')).toBeVisible();
  });

  /** A straight-line fallback under-reports, because trails weave. The hedge is the disclosure. */
  it('says "at least" when the approach was never routed', () => {
    renderView(
      access({ putIns: [{ ...LAUNCH, approachRouted: false, approachAscentM: undefined }] }),
    );
    expect(screen.getByText(/at least/)).toBeVisible();
    expect(screen.queryByText(/of climb/)).not.toBeInTheDocument();
  });

  /** A pull-off has no approach worth a sentence, and the honest thing to say is nothing. */
  it('says nothing about the walk for a drive-up launch', () => {
    renderView(access({ putIns: [{ ...LAUNCH, approachMeters: 40 }] }));
    expect(screen.queryByText(/on foot/)).not.toBeInTheDocument();
    expect(screen.queryByText('Hike-in')).not.toBeInTheDocument();
  });

  /**
   * **The never-hide invariant** (open question 3), which is the one rule here a refactor could
   * plausibly break while looking correct. An alert annotates and de-prioritizes; it never suppresses.
   * A lake with one locked gate is still a lake worth telling someone about.
   */
  it('keeps a blocked launch on screen, named and routable, beside its warning', () => {
    renderView(
      access({
        blockedIds: [id<PutIn['id']>('p1')],
        alerts: [alert({ note: 'Chain at the town line' })],
      }),
    );
    expect(screen.getByText(/put in at North launch/)).toBeVisible();
    expect(screen.getByText(/Gate locked — North launch/)).toBeVisible();
    expect(screen.getByText('Chain at the town line')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Still blocked' })).toBeVisible();
  });

  /** A pinned alert is a moderator's claim, not a community one, so it is not put to a vote. */
  it('offers no verdict buttons on an official pin', () => {
    renderView(
      access({
        alerts: [alert({ reason: 'road_closed', official: true })],
      }),
    );
    expect(screen.getByText(/confirmed by a moderator/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Still blocked' })).not.toBeInTheDocument();
  });

  /**
   * Most of the corpus has no access data at all, and B4's discipline is that its absence is the
   * honest signal — a panel reading "we don't know where to park" on 20,000 lakes is worse than none.
   */
  it('renders nothing at all when there is no access data', () => {
    const { container } = renderView(access({ putIns: [], parking: [] }));
    expect(container).toBeEmptyDOMElement();
  });
});
