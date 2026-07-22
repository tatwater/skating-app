import type { DirectionalFix, LatLng } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  advanceOnIceSession,
  dismissBanner,
  emptyAlertSession,
  type HazardRow,
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
