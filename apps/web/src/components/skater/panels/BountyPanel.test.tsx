import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { fakes, resetFakes } from '../testMocks';
import {
  convexWithActions,
  panelFakes,
  panelRouter,
  polyfillAnimate,
  resetPanelFakes,
} from './panelTestMocks';

vi.mock('convex/react', () => convexWithActions);
vi.mock('@tanstack/react-router', () => panelRouter);
vi.mock('@/lib/analytics', async (load) => ({
  ...(await load<typeof import('@/lib/analytics')>()),
  useAnalytics: () => ({ capture: fakes.capture }),
}));

import { BountyPanel, wantersFor } from './BountyPanel';
import { BountyPanelView, wantLine } from './BountyPanelView';
import { InsetCard, PanelColumn } from './InsetCard';
import { BOUNTY_MINE, BOUNTY_NORTH } from './panelFixtures';

const now = Date.now();
const DETAIL = {
  _id: 'b1',
  status: 'open',
  rewardPoints: 20,
  createdAt: now - 3_600_000,
  expiresAt: now + 2 * 86_400_000,
  waterBody: { _id: 'w1', name: 'Mascoma Lake' },
  subArea: { _id: 's1', name: 'Mascoma North' },
  requester: { userId: 'u1', displayName: 'Rob Tremblay', username: 'rtremblay' },
  isRequester: false,
  fulfillingReports: [
    {
      _id: 'r2',
      skateEndTime: now - 86_400_000,
      authorName: 'Sarah Berman',
      authorTrustClass: null,
      isOwn: false,
    },
    {
      _id: 'r3',
      skateEndTime: now - 3_600_000,
      skateQuality: 'fair',
      authorName: 'Ana Morales',
      authorTrustClass: null,
      isOwn: false,
    },
  ],
};
const OPEN = [
  { subAreaName: 'Mascoma North', requester: { displayName: 'Matt Ochs', username: 'mochs' } },
  {
    subAreaName: 'Mascoma North',
    requester: {
      displayName: 'Ana Morales',
      username: 'amorales',
      profileImageUrl: 'https://img/a.jpg',
    },
  },
  { requester: { displayName: 'Kate Donovan', username: 'kdonovan' } },
  {
    subAreaName: 'Mascoma North',
    requester: { displayName: 'Rob Tremblay', username: 'rtremblay' },
  },
];

beforeAll(polyfillAnimate);
beforeEach(() => {
  resetFakes();
  resetPanelFakes();
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
});

function seed(
  over: Record<string, unknown> = {},
  me: Record<string, unknown> | null = {
    _id: 'u9',
    status: 'active',
    username: 'placasse',
    displayName: 'Pat',
  },
) {
  fakes.queries.set('bounties:getDetail', { ...DETAIL, ...over });
  fakes.queries.set('bounties:listForBody', OPEN);
  fakes.queries.set('ratings:summaryForTarget', { helpful: 4, unhelpful: 0, mine: null });
  if (me) fakes.queries.set('profiles:current', me);
}

const renderPanel = () =>
  render(
    <PanelColumn>
      <BountyPanel bountyId="b1" />
    </PanelColumn>,
  );

describe('the ask, in people', () => {
  it('says "3 want a report" only here, and yours as yours', () => {
    const three = [{ displayName: 'A' }, { displayName: 'B' }, { displayName: 'C' }];
    expect(wantLine(three, false)).toBe('3 want a report');
    expect(wantLine([{ displayName: 'Rob Tremblay' }], false)).toBe('Rob Tremblay wants a report');
    expect(wantLine([{ displayName: 'Kate' }], true)).toBe('You want a report');
    expect(wantLine(three.slice(0, 2), true)).toBe('You and 1 other want a report');
    expect(wantLine(three, true)).toBe('You and 2 others want a report');
  });

  it('gathers the asks on the same target, and falls back to the requester', () => {
    const rob = { displayName: 'Rob Tremblay' };
    expect(wantersFor(OPEN, 'Mascoma North', rob).map((w) => w.displayName)).toEqual([
      'Matt Ochs',
      'Ana Morales',
      'Rob Tremblay',
    ]);
    expect(wantersFor(OPEN, null, rob).map((w) => w.displayName)).toEqual(['Kate Donovan']);
    expect(wantersFor(undefined, null, rob)).toEqual([rob]);
    expect(wantersFor([], 'Mascoma North', rob)).toEqual([rob]);
  });
});

describe('BountyPanel', () => {
  it('loads in the frame, then says when the bounty isn’t there', async () => {
    const { unmount } = renderPanel();
    expect(await screen.findByRole('dialog', { name: 'Bounty' })).toBeInTheDocument();
    unmount();
    fakes.queries.set('bounties:getDetail', null);
    renderPanel();
    expect(await screen.findByRole('dialog', { name: 'Bounty not available' })).toBeInTheDocument();
  });

  it('draws board 2.6: three want a report, no points, back to the bay', async () => {
    seed();
    renderPanel();
    expect(await screen.findByRole('dialog', { name: 'Mascoma North' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back to Mascoma North/ })).toBeInTheDocument();
    expect(screen.getByText('3 want a report')).toBeInTheDocument();
    expect(screen.getByText('Rob Tremblay asked first')).toBeInTheDocument();
    expect(screen.getByText(/only a report from this bay fulfills it/)).toBeInTheDocument();
    expect(screen.queryByText(/pts|points/i)).toBeNull();
    expect(useSkaterMapStore.getState().specs.view?.focus).toEqual({
      bodyId: 'w1',
      subAreaId: 's1',
    });
    expect(fakes.capture).toHaveBeenCalledWith('bounty_viewed', { source: 'deep_link' });
    // Candidates: the thumbs show their count; only the requester gets Not helpful.
    const rows = document.querySelectorAll('[data-slot="bounty-candidate"]');
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText('Fair')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not helpful' })).toBeNull();
  });

  it('opens the report sheet over the card, and asks on your behalf', async () => {
    seed();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError('There’s a fresh report already'))
      .mockResolvedValue('b2');
    panelFakes.actions.set('bounties:create', create);
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: /Add a report/ }));
    const call = panelFakes.navigate.mock.calls[0]?.[0];
    expect(call).toMatchObject({ to: '/bounty/$id', params: { id: 'b1' } });
    expect(call.search({})).toEqual({ post: 'new', postBody: 'w1' });

    await userEvent.click(screen.getByRole('button', { name: /I want this too/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('There’s a fresh report already');
    await userEvent.click(screen.getByRole('button', { name: /I want this too/ }));
    expect(create).toHaveBeenLastCalledWith({ waterBodyId: 'w1', subAreaId: 's1' });
    await waitFor(() =>
      expect(fakes.capture).toHaveBeenCalledWith('bounty_posted', { scoped_to_sub_area: true }),
    );
  });

  it('doesn’t offer "I want this too" to someone who already asked', async () => {
    seed({}, { _id: 'u5', status: 'active', username: 'mochs', displayName: 'Matt' });
    renderPanel();
    await screen.findByRole('button', { name: /Add a report/ });
    expect(screen.queryByRole('button', { name: /I want this too/ })).toBeNull();
  });

  it('gives the requester the fulfilling thumbs and a cancel that asks, arms red, and acts', async () => {
    seed({ isRequester: true, subArea: null, fulfillingReports: [DETAIL.fulfillingReports[1]] });
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(new ConvexError('Bounty is not open'))
      .mockResolvedValue(null);
    fakes.mutations.set('bounties:cancel', cancel);
    renderPanel();
    expect(await screen.findByText('You want a report')).toBeInTheDocument();
    // A lake-wide bounty frames the lake, no bay.
    expect(useSkaterMapStore.getState().specs.view?.focus).toEqual({ bodyId: 'w1' });
    expect(screen.getByText('A helpful thumb from you fulfills the bounty.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Helpful, 4' }));
    expect(fakes.mutations.get('ratings:rate')).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'r3', verdict: 'helpful', bountyId: 'b1' }),
    );

    const trigger = screen.getByRole('button', { name: 'Cancel bounty' });
    expect(trigger).toHaveClass('text-bad');
    await userEvent.click(trigger);
    await screen.findByRole('alertdialog');
    const action = () =>
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /Cancel bounty/ });
    await userEvent.click(action()); // arms
    expect(cancel).not.toHaveBeenCalled();
    await userEvent.click(action()); // acts
    expect(await screen.findByText('Bounty is not open')).toBeInTheDocument();
    await userEvent.click(action());
    await userEvent.click(action());
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
    expect(cancel).toHaveBeenCalledWith({ bountyId: 'b1' });
  });

  it('offers nothing in the foot once it’s closed', async () => {
    seed({ status: 'fulfilled', fulfillingReports: [] });
    renderPanel();
    expect(await screen.findByText(/^Fulfilled$/)).toBeInTheDocument();
    expect(document.querySelector('[data-slot="inset-card-foot"]')).toBeNull();
    expect(screen.getByText(/No reports yet/)).toBeInTheDocument();
  });
});

describe('BountyPanelView', () => {
  const inCard = (node: React.ReactNode) => (
    <PanelColumn>
      <InsetCard backTo="Mascoma Lake" onClose={vi.fn()} returnKey="bounty:b1" label="Bounty">
        {node}
      </InsetCard>
    </PanelColumn>
  );

  it('draws 2.6 and 2.7 from the fixtures', async () => {
    const { unmount } = render(inCard(<BountyPanelView data={BOUNTY_NORTH} />));
    expect(await screen.findByText('3 want a report')).toBeInTheDocument();
    expect(screen.getByText('3 open bounties')).toBeInTheDocument();
    unmount();
    render(
      inCard(<BountyPanelView data={BOUNTY_MINE} rateCandidate={() => <span>thumbs</span>} />),
    );
    expect(await screen.findByText('Any part of Mascoma Lake')).toBeInTheDocument();
    expect(screen.getByText('1 open bounty')).toBeInTheDocument();
    expect(screen.getByText('thumbs')).toBeInTheDocument();
  });
});
