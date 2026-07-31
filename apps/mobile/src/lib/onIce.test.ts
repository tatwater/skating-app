import type { DirectionalFix, LatLng } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  type AlertSession,
  advanceOnIceSession,
  dismissBanner,
  emptyAlertSession,
  type HazardRow,
  type RealertCadence,
  resolveOnIceBody,
  shouldAutoSelectOnIce,
  toProximityHazards,
} from './onIce';

const HERE: LatLng = { lat: 44.4759, lng: -73.2121 };
/** ~250 m north of HERE — outside the 150 m default alert buffer for a small footprint. */
const AWAY: LatLng = { lat: 44.4781, lng: -73.2121 };

/** A stationary fix (heading unknown, speed 0) — proximity fires, directional is guarded off. */
function still(coord: LatLng): DirectionalFix {
  return { coord, headingDeg: -1, speedMps: 0 };
}

function row(overrides: Partial<HazardRow> = {}): HazardRow {
  return {
    _id: 'h1',
    type: 'open_water',
    geometryKind: 'point_radius',
    geometry: { type: 'Point', coordinates: [HERE.lng, HERE.lat] },
    radiusMeters: 30,
    confirmCount: 2,
    ...overrides,
  };
}

const hazards = (...rows: HazardRow[]) => toProximityHazards(rows);

describe('toProximityHazards', () => {
  it('carries only the size field the geometry kind actually uses', () => {
    const [circle, line] = toProximityHazards([
      row(),
      row({ _id: 'h2', geometryKind: 'line', radiusMeters: undefined, bufferMeters: 12 }),
    ]);
    expect(circle?.shape).toMatchObject({ geometryKind: 'point_radius', radiusMeters: 30 });
    expect(circle?.shape.bufferMeters).toBeUndefined();
    expect(line?.shape).toMatchObject({ geometryKind: 'line', bufferMeters: 12 });
    expect(line?.shape.radiusMeters).toBeUndefined();
  });

  // The gate N5c §1.2 opens with. Three skaters mark one ridge, nobody taps confirm: every row's own
  // `confirmCount` is 0, and reading it would leave every phone on the lake at the soft prompt for a
  // hazard the community has plainly corroborated.
  it('escalates on what the cluster knows, not on what one row does', () => {
    const [pooled] = toProximityHazards([row({ confirmCount: 0, clusterConfirmCount: 2 })]);
    expect(pooled?.confirmCount).toBe(2);
  });

  it('falls back to the row for a singleton, where the two are equal by construction', () => {
    const [alone] = toProximityHazards([row({ confirmCount: 1 })]);
    expect(alone?.confirmCount).toBe(1);
  });
});

describe('advanceOnIceSession — proximity (Layer 1)', () => {
  it('raises a banner for a confirmed hazard underfoot, and reports it as fired', () => {
    const next = advanceOnIceSession(emptyAlertSession(), still(HERE), hazards(row()));
    expect(next.banner).toMatchObject({ hazardId: 'h1', kind: 'warning', distanceMeters: 0 });
    expect(next.fired?.hazardId).toBe('h1');
  });

  it('raises the soft confirm prompt for an unconfirmed one — the gate is the confirmation', () => {
    const next = advanceOnIceSession(
      emptyAlertSession(),
      still(HERE),
      hazards(row({ confirmCount: 0 })),
    );
    expect(next.banner?.kind).toBe('confirm_request');
  });

  // …and the whole point of pooling: the same unconfirmed row, once the server has judged it one
  // hazard with pins other people drew, warns properly (N5c / D80).
  it('warns for a pin no one confirmed whose cluster other skaters independently drew', () => {
    const next = advanceOnIceSession(
      emptyAlertSession(),
      still(HERE),
      hazards(row({ confirmCount: 0, clusterConfirmCount: 2 })),
    );
    expect(next.banner?.kind).toBe('warning');
  });

  it('stays quiet when nothing is near', () => {
    const next = advanceOnIceSession(emptyAlertSession(), still(AWAY), hazards(row()));
    expect(next.banner).toBeNull();
    expect(next.fired).toBeNull();
    expect(next.alerted.size).toBe(0);
  });

  // Skating laps on a pond would otherwise re-fire the same banner every circuit and train the
  // skater to ignore it — worse than never alerting.
  it('never re-raises the same hazard within a once-per-session (default)', () => {
    const raised = advanceOnIceSession(emptyAlertSession(), still(HERE), hazards(row()));
    const next = advanceOnIceSession(dismissBanner(raised), still(HERE), hazards(row()));
    expect(next.banner).toBeNull();
    expect(next.fired).toBeNull();
  });

  // A fix arrives every couple of seconds; swapping the banner underneath a moving skater would
  // make it unreadable and could switch a confirm prompt to a warning mid-tap.
  it('does not replace a banner that is already showing', () => {
    const first = advanceOnIceSession(emptyAlertSession(), still(HERE), hazards(row()));
    const second = advanceOnIceSession(first, still(HERE), hazards(row(), row({ _id: 'h2' })));
    expect(second.banner?.hazardId).toBe('h1');
    expect(second.fired).toBeNull();
    expect(second.alerted.has('h2')).toBe(false); // still queued, not silently consumed
  });

  it('surfaces the queued hazard once the first banner is dismissed', () => {
    let session = advanceOnIceSession(
      emptyAlertSession(),
      still(HERE),
      hazards(row(), row({ _id: 'h2' })),
    );
    const dismissed = dismissBanner(session);
    session = advanceOnIceSession(dismissed, still(HERE), hazards(row(), row({ _id: 'h2' })));
    expect(session.banner?.hazardId).toBe('h2');
  });

  it('shows the nearest hazard first', () => {
    const near = row({ _id: 'near' });
    const far = row({
      _id: 'far',
      geometry: { type: 'Point', coordinates: [HERE.lng, HERE.lat + 0.001] },
      radiusMeters: 5,
    });
    const session = advanceOnIceSession(emptyAlertSession(), still(HERE), hazards(far, near));
    expect(session.banner?.hazardId).toBe('near');
  });

  // A ridge crossing marks where you *can* get across. "⚠ hazard ahead" on the safest point of a
  // ridge would be actively counterproductive (research §4).
  it('never warns about a ridge crossing', () => {
    const session = advanceOnIceSession(
      emptyAlertSession(),
      still(HERE),
      hazards(row({ type: 'ridge_crossing' })),
    );
    expect(session.banner).toBeNull();
  });
});

describe('advanceOnIceSession — directional (Layer 2)', () => {
  // ~450 m north of HERE — 45 s out at 10 m/s, inside the [30, 60] s lead window.
  const AHEAD: LatLng = { lat: HERE.lat + 450 / 111_320, lng: HERE.lng };
  const skatingNorth: DirectionalFix = { coord: HERE, headingDeg: 0, speedMps: 10 };
  const aheadRow = row({
    _id: 'ahead',
    geometry: { type: 'Point', coordinates: [AHEAD.lng, AHEAD.lat] },
  });

  it('does not fire directionally unless armed (directional:true)', () => {
    const off = advanceOnIceSession(emptyAlertSession(), skatingNorth, hazards(aheadRow));
    expect(off.banner).toBeNull();
  });

  it('fires for a hazard ahead when armed, carrying its lead time', () => {
    const on = advanceOnIceSession(emptyAlertSession(), skatingNorth, hazards(aheadRow), {
      directional: true,
    });
    expect(on.banner?.hazardId).toBe('ahead');
    expect(on.banner?.secondsToEncounter).toBeGreaterThanOrEqual(30);
    expect(on.banner?.secondsToEncounter).toBeLessThanOrEqual(60);
  });

  it('prefers a proximity hit over a directional one on the same fix (you’re on it beats it’s ahead)', () => {
    const underfoot = row({ _id: 'underfoot' });
    const on = advanceOnIceSession(
      emptyAlertSession(),
      skatingNorth,
      hazards(aheadRow, underfoot),
      {
        directional: true,
      },
    );
    expect(on.banner?.hazardId).toBe('underfoot');
    expect(on.banner?.secondsToEncounter).toBeUndefined();
  });
});

describe('advanceOnIceSession — re-alert cadence', () => {
  it('every-approach re-fires a hazard after the skater leaves and returns', () => {
    // Fire it underfoot, dismiss the banner, skate away past the hysteresis band, then return.
    const raised = advanceOnIceSession(emptyAlertSession(), still(HERE), hazards(row()), {
      cadence: 'every_approach',
    });
    expect(raised.fired?.hazardId).toBe('h1');
    // Away is ~250 m; with a 60 m buffer the hysteresis band is 120 m, so the skater has clearly left.
    const left = advanceOnIceSession(dismissBanner(raised), still(AWAY), hazards(row()), {
      cadence: 'every_approach',
      alertBufferMeters: 60,
    });
    expect(left.alerted.has('h1')).toBe(false); // released — skated away
    const back = advanceOnIceSession(left, still(HERE), hazards(row()), {
      cadence: 'every_approach',
    });
    expect(back.fired?.hazardId).toBe('h1'); // re-fires on return
  });

  it('once-per-session never re-fires, even after leaving and returning', () => {
    const raised = advanceOnIceSession(emptyAlertSession(), still(HERE), hazards(row()));
    const left = advanceOnIceSession(dismissBanner(raised), still(AWAY), hazards(row()));
    const back = advanceOnIceSession(left, still(HERE), hazards(row()));
    expect(back.fired).toBeNull(); // still suppressed
  });
});

// A directional alert fires ~45 s *ahead* — far beyond the hysteresis band — so a naive "distance >
// hysteresis" release re-arms it on the very next fix and re-fires it on every fix through the whole
// approach (9+ notifications for one hazard in the background path). The `approached` gate fixes this:
// a hazard can only be *left* (and re-armed) once the skater has actually *entered* its vicinity.
describe('advanceOnIceSession — directional re-alert does not machine-gun (regression)', () => {
  const M_PER_DEG = 111_320;
  const aheadRow = row({
    _id: 'ahead',
    geometry: { type: 'Point', coordinates: [HERE.lng, HERE.lat + 600 / M_PER_DEG] },
    radiusMeters: 20,
  });

  /**
   * Fold a straight northbound (heading 0) or southbound (heading 180) leg at 8 m/s, one fix per
   * `stepM`, through the **background** path (banner cleared each fix, as `ingestOnIceFix` does) —
   * counting how many alerts fire. Chains from a prior session so a pass-and-return can be expressed.
   */
  function skateLeg(
    session: AlertSession,
    cadence: RealertCadence,
    fromM: number,
    toM: number,
    stepM: number,
  ): { fires: number; session: AlertSession } {
    const haz = hazards(aheadRow);
    const dir = toM >= fromM ? 1 : -1;
    let s = session;
    let fires = 0;
    for (let d = fromM; dir > 0 ? d <= toM : d >= toM; d += dir * stepM) {
      const fix: DirectionalFix = {
        coord: { lat: HERE.lat + d / M_PER_DEG, lng: HERE.lng },
        headingDeg: dir > 0 ? 0 : 180,
        speedMps: 8,
      };
      const base: AlertSession = { alerted: s.alerted, approached: s.approached, banner: null };
      const r = advanceOnIceSession(base, fix, haz, { cadence, directional: true });
      s = { alerted: r.alerted, approached: r.approached, banner: null };
      if (r.fired) fires++;
    }
    return { fires, session: s };
  }

  it('every-approach: one straight approach fires exactly once, not once per fix', () => {
    expect(skateLeg(emptyAlertSession(), 'every_approach', 0, 620, 20).fires).toBe(1);
  });

  it('once-per-session: one straight approach fires exactly once', () => {
    expect(skateLeg(emptyAlertSession(), 'once_per_session', 0, 620, 20).fires).toBe(1);
  });

  it('every-approach: a genuine re-approach (pass through, turn around, come back) fires again', () => {
    // North through the hazard (~600 m) and well past it, so the skater both enters and leaves it.
    const north = skateLeg(emptyAlertSession(), 'every_approach', 0, 960, 20);
    expect(north.fires).toBe(1);
    // Turn around and skate back at it — a real re-approach, so it re-arms and fires a second time.
    const back = skateLeg(north.session, 'every_approach', 940, 0, 20);
    expect(back.fires).toBe(1);
  });

  it('once-per-session: after passing through and returning, it never re-fires', () => {
    const north = skateLeg(emptyAlertSession(), 'once_per_session', 0, 960, 20);
    expect(north.fires).toBe(1);
    const back = skateLeg(north.session, 'once_per_session', 940, 0, 20);
    expect(back.fires).toBe(0); // suppressed for the whole session
  });
});

describe('dismissBanner', () => {
  // Swiping a banner away and declaring a hazard gone are different claims. Collapsing them is
  // exactly the D3 failure mode, so a dismissal touches nothing but the banner.
  it('clears the banner and nothing else', () => {
    const session = advanceOnIceSession(emptyAlertSession(), still(HERE), hazards(row()));
    const dismissed = dismissBanner(session);
    expect(dismissed.banner).toBeNull();
    expect(dismissed.alerted).toBe(session.alerted);
  });
});

describe('resolveOnIceBody', () => {
  it('prefers the server answer once it arrives', () => {
    // Server says lake A even though the cache has B — the server covers lakes never opened here.
    expect(resolveOnIceBody('A', 'B')).toBe('A');
  });

  it('trusts the server saying "not on any lake"', () => {
    expect(resolveOnIceBody(null, 'B')).toBeNull();
  });

  it('falls back to the cache while the server has not answered (loading / offline)', () => {
    expect(resolveOnIceBody(undefined, 'B')).toBe('B');
  });

  it('resolves to nothing when neither source has a lake', () => {
    expect(resolveOnIceBody(undefined, null)).toBeNull();
  });
});

describe('shouldAutoSelectOnIce', () => {
  const base = {
    resolvedBodyId: 'lake' as string | null,
    alreadyAutoSelected: false,
    openedOnBareMap: true,
    onBareMapNow: true,
  };

  it('auto-selects the resolved lake on a fresh open of the bare map', () => {
    expect(shouldAutoSelectOnIce(base)).toBe(true);
  });

  it('never fires twice in one session', () => {
    expect(shouldAutoSelectOnIce({ ...base, alreadyAutoSelected: true })).toBe(false);
  });

  it('does not hijack a deep-linked open', () => {
    expect(shouldAutoSelectOnIce({ ...base, openedOnBareMap: false })).toBe(false);
  });

  it('does not yank a skater who has since navigated away', () => {
    expect(shouldAutoSelectOnIce({ ...base, onBareMapNow: false })).toBe(false);
  });

  it('does nothing until a lake resolves', () => {
    expect(shouldAutoSelectOnIce({ ...base, resolvedBodyId: null })).toBe(false);
  });
});
