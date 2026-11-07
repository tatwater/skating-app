import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANALYTICS_ENUMS } from '@/lib/analytics';
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

import { HazardPanel, VERDICT_EVENT } from './HazardPanel';
import { HazardPanelView, healedConfirmLabel, VERDICTS } from './HazardPanelView';
import { InsetCard, PanelColumn } from './InsetCard';
import { HAZARD_LEAD, HAZARD_THIN } from './panelFixtures';

const DAY = 86_400_000;
const now = Date.now();
const HAZARD = {
  _id: 'h1',
  waterBodyId: 'w1',
  createdByUserId: 'u1',
  type: 'open_water',
  freshness: 'fresh',
  provisional: false,
  healingState: undefined,
  expired: false,
  status: 'active',
  description: 'Open lead from the bridge pilings into the north basin.',
  subAreaName: 'Mascoma North',
  firstReportedAt: now - 2 * DAY,
  lastConfirmedAt: now - DAY,
  confirmCount: 2,
  snowHidden: true,
  bbox: { minLat: 43.6, maxLat: 43.7, minLng: -72.4, maxLng: -72.3 },
};

beforeAll(polyfillAnimate);
beforeEach(() => {
  resetFakes();
  resetPanelFakes();
  useSkaterMapStore.setState({ specs: { view: null, flow: null } });
});

function seed(over: Record<string, unknown> = {}) {
  fakes.queries.set('hazards:get', { ...HAZARD, ...over });
  fakes.queries.set('photos:getHazardUrls', []);
  fakes.queries.set('waterBodies:get', {
    available: true,
    body: { _id: 'w1', name: 'Mascoma Lake' },
  });
  fakes.queries.set('profiles:publicByIds', {
    u1: { displayName: 'Sarah Berman', username: 'sberman' },
  });
  fakes.queries.set('hazards:listClusterMembers', []);
  fakes.queries.set('hazardConfirmations:listForHazard', [
    { verdict: 'still_there', isAuthor: false, displayName: 'Rob Tremblay' },
    { verdict: 'still_there', isAuthor: false, displayName: 'Pat Lacasse' },
    { verdict: 'still_there', isAuthor: true, displayName: 'Sarah Berman' },
    { verdict: 'healing_unsafe', isAuthor: false, displayName: 'Matt Ochs' },
  ]);
  fakes.queries.set('profiles:current', { _id: 'u9', status: 'active', displayName: 'Kate' });
}

const renderPanel = (action?: 'confirm') =>
  render(
    <PanelColumn>
      <HazardPanel hazardId="h1" {...(action ? { action } : {})} />
    </PanelColumn>,
  );

describe('the verdict taxonomy', () => {
  it('counts each verdict by a name the taxonomy has, or not at all', () => {
    for (const verdict of VERDICTS) {
      const counted = VERDICT_EVENT[verdict];
      if (counted !== null) expect(ANALYTICS_ENUMS.hazard_verdict).toContain(counted);
    }
    expect(VERDICT_EVENT.never_existed).toBeNull();
  });

  it('words the second confirmation as what a person saw', () => {
    expect(healedConfirmLabel('thin_ice')).toBe('Yes, I don’t see it anymore');
    expect(healedConfirmLabel('ridge_crossing')).toBe('Yes, the crossing is gone');
  });
});

describe('HazardPanel', () => {
  it('loads in the frame, then says not found without saying it’s gone (D3)', async () => {
    const { unmount } = renderPanel();
    expect(await screen.findByRole('dialog', { name: 'Hazard' })).toBeInTheDocument();
    unmount();
    fakes.queries.set('hazards:get', null);
    renderPanel();
    expect(await screen.findByRole('dialog', { name: 'Hazard not found' })).toBeInTheDocument();
    expect(screen.getByText(/may have been removed from the map/)).toBeInTheDocument();
    expect(screen.queryByText(/no longer there|cleared|gone/i)).toBeNull();
  });

  it('draws the hazard, names confirmers but never the reporter as their own, brackets its mark', async () => {
    seed();
    renderPanel();
    expect(await screen.findByRole('dialog', { name: 'Open water / lead' })).toBeInTheDocument();
    expect(
      screen.getByText(/by Sarah Berman · confirmed by Rob Tremblay and Pat Lacasse/),
    ).toBeInTheDocument();
    expect(screen.getByText('Recently reported')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mascoma Lake' })).toHaveAttribute('href', '/water/w1');
    const spec = useSkaterMapStore.getState().specs.view;
    expect(spec?.focus).toEqual({ bodyId: 'w1', hazardId: 'h1' });
    expect(fakes.capture).toHaveBeenCalledWith('hazard_viewed', { source: 'deep_link' });
    expect(panelFakes.actions.get('weather:getWeatherSinceForBody')).toHaveBeenCalledWith({
      hazardId: 'h1',
    });
  });

  it('takes a verdict, and counts it by the taxonomy’s name', async () => {
    seed();
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: /Healing — still unsafe/ }));
    expect(fakes.mutations.get('hazardConfirmations:confirm')).toHaveBeenCalledWith({
      hazardId: 'h1',
      verdict: 'healing_unsafe',
      via: 'app_open_nearby',
    });
    await waitFor(() =>
      expect(fakes.capture).toHaveBeenCalledWith('hazard_verdict_submitted', {
        verdict: 'healing',
      }),
    );
  });

  it('asks twice before Fully healed, in ice; Esc disarms without closing the card', async () => {
    seed();
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: /^Fully healed/ }));
    const confirm = document.querySelector('[data-slot="healed-confirm"]') as HTMLElement;
    expect(confirm).toHaveClass('border-acc', 'bg-acc-wash');
    expect(confirm.className).not.toMatch(/bad/);
    expect(fakes.mutations.get('hazardConfirmations:confirm')).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(document.querySelector('[data-slot="healed-confirm"]')).toBeNull();
    expect(panelFakes.navigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /^Fully healed/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('[data-slot="healed-confirm"]')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /^Fully healed/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, I don’t see it anymore' }));
    expect(fakes.mutations.get('hazardConfirmations:confirm')).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'fully_healed' }),
    );
    await waitFor(() =>
      expect(fakes.capture).toHaveBeenCalledWith('hazard_verdict_submitted', {
        verdict: 'fully_healed',
      }),
    );
  });

  it('doesn’t count “never was”, and says when a verdict didn’t land', async () => {
    seed();
    fakes.mutations.set(
      'hazardConfirmations:confirm',
      vi.fn().mockRejectedValueOnce(new ConvexError('Too far away')).mockResolvedValue(null),
    );
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: /Nothing here — never was/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too far away');
    await userEvent.click(screen.getByRole('button', { name: /Nothing here — never was/ }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(fakes.capture).not.toHaveBeenCalledWith('hazard_verdict_submitted', expect.anything());
  });

  it('opens on the verdicts for ?action=confirm, and never pre-arms Fully healed', async () => {
    seed();
    renderPanel('confirm');
    const group = await screen.findByRole('group', { name: 'Seen this recently?' });
    await waitFor(() => expect(group).toHaveFocus());
    expect(document.querySelector('[data-slot="healed-confirm"]')).toBeNull();
  });

  it('takes no verdicts on a retired marker, and writes the notes that keep an old one from reading clear', async () => {
    seed({
      status: 'archived',
      freshness: 'aging',
      provisional: true,
      healingState: 'disputed',
      type: 'ridge_crossing',
      expired: true,
      promotedFeatureType: 'pressure_ridge',
      firstReportedAt: new Date(2020, 0, 5).getTime(),
      confirmCount: 0,
    });
    fakes.queries.set('hazards:listClusterMembers', [{ hazardId: 'h1' }, { hazardId: 'h7' }]);
    fakes.queries.set('hazardConfirmations:listForHazard', []);
    fakes.queries.set('profiles:publicByIds', {});
    renderPanel();
    await screen.findByRole('dialog');
    expect(screen.queryByRole('group')).toBeNull();
    for (const badge of [
      'Unconfirmed',
      'Disputed',
      'Crossing point',
      'Aged off the map',
      'Retired',
    ]) {
      expect(screen.getByText(badge)).toBeInTheDocument();
    }
    expect(screen.getByText(/season\. It isn’t on the map this winter/)).toBeInTheDocument();
    expect(screen.getByText(/2 skaters have marked this spot separately/)).toBeInTheDocument();
    expect(screen.getByText(/nobody else has confirmed it yet/)).toBeInTheDocument();
    // An archived marker fetches no weather.
    expect(panelFakes.actions.get('weather:getWeatherSinceForBody')).toBeUndefined();
  });

  it('says the healing note for a healing hazard', async () => {
    seed({ healingState: 'healing_unsafe', type: 'thin_ice' });
    renderPanel();
    expect(
      await screen.findByText(/Reported healing, but still called unsafe/),
    ).toBeInTheDocument();
  });
});

describe('HazardPanelView', () => {
  const inCard = (node: React.ReactNode) => (
    <PanelColumn>
      <InsetCard backTo="Mascoma Lake" onClose={vi.fn()} returnKey="hazard:h1" label="Hazard">
        {node}
      </InsetCard>
    </PanelColumn>
  );

  it('draws board 2.3’s notes and asks about a crossing differently', async () => {
    render(
      inCard(
        <HazardPanelView
          data={{
            ...HAZARD_THIN,
            type: 'ridge_crossing',
            photos: [{ photoId: 'p', thumbUrl: 'https://img/h.jpg' }],
          }}
          onVerdict={vi.fn()}
          confirming
        />,
      ),
    );
    expect(await screen.findByRole('group', { name: 'Been through here?' })).toBeInTheDocument();
    for (const note of HAZARD_THIN.notes) expect(screen.getByText(note)).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', { name: /crossing|Ridge|dicey/i })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole('img', { name: 'Thin ice, photo 1' })).toBeInTheDocument();
  });

  it('draws without a lake name or reporter', async () => {
    render(inCard(<HazardPanelView data={{ ...HAZARD_LEAD, bodyName: null, reporter: null }} />));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('group')).toBeNull();
  });
});
