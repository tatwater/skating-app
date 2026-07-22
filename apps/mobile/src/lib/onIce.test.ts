import type { LatLng } from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  advanceAlertSession,
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

describe('advanceAlertSession', () => {
  it('raises a banner for a confirmed hazard underfoot', () => {
    const next = advanceAlertSession(emptyAlertSession(), HERE, hazards(row()));
    expect(next.banner).toMatchObject({ hazardId: 'h1', kind: 'warning', distanceMeters: 0 });
  });

  it('raises the soft confirm prompt for an unconfirmed one — the gate is the confirmation', () => {
    const next = advanceAlertSession(emptyAlertSession(), HERE, hazards(row({ confirmCount: 0 })));
    expect(next.banner?.kind).toBe('confirm_request');
  });

  it('stays quiet when nothing is near', () => {
    const next = advanceAlertSession(emptyAlertSession(), AWAY, hazards(row()));
    expect(next.banner).toBeNull();
    expect(next.alerted.size).toBe(0);
  });

  // Skating laps on a pond would otherwise re-fire the same banner every circuit and train the
  // skater to ignore it — worse than never alerting.
  it('never re-raises the same hazard within a session', () => {
    let session = advanceAlertSession(emptyAlertSession(), HERE, hazards(row()));
    session = dismissBanner(session);
    session = advanceAlertSession(session, HERE, hazards(row()));
    expect(session.banner).toBeNull();
  });

  // A fix arrives every couple of seconds; swapping the banner underneath a moving skater would
  // make it unreadable and could switch a confirm prompt to a warning mid-tap.
  it('does not replace a banner that is already showing', () => {
    const first = advanceAlertSession(emptyAlertSession(), HERE, hazards(row()));
    const second = advanceAlertSession(first, HERE, hazards(row(), row({ _id: 'h2' })));
    expect(second.banner?.hazardId).toBe('h1');
    expect(second.alerted.has('h2')).toBe(false); // still queued, not silently consumed
  });

  it('surfaces the queued hazard once the first banner is dismissed', () => {
    let session = advanceAlertSession(
      emptyAlertSession(),
      HERE,
      hazards(row(), row({ _id: 'h2' })),
    );
    session = dismissBanner(session);
    session = advanceAlertSession(session, HERE, hazards(row(), row({ _id: 'h2' })));
    expect(session.banner?.hazardId).toBe('h2');
  });

  it('shows the nearest hazard first', () => {
    const near = row({ _id: 'near' });
    const far = row({
      _id: 'far',
      geometry: { type: 'Point', coordinates: [HERE.lng, HERE.lat + 0.001] },
      radiusMeters: 5,
    });
    const session = advanceAlertSession(emptyAlertSession(), HERE, hazards(far, near));
    expect(session.banner?.hazardId).toBe('near');
  });

  // A ridge crossing marks where you *can* get across. "⚠ hazard ahead" on the safest point of a
  // ridge would be actively counterproductive (research §4).
  it('never warns about a ridge crossing', () => {
    const session = advanceAlertSession(
      emptyAlertSession(),
      HERE,
      hazards(row({ type: 'ridge_crossing' })),
    );
    expect(session.banner).toBeNull();
  });
});

describe('dismissBanner', () => {
  // Swiping a banner away and declaring a hazard gone are different claims. Collapsing them is
  // exactly the D3 failure mode, so a dismissal touches nothing but the banner.
  it('clears the banner and nothing else', () => {
    const session = advanceAlertSession(emptyAlertSession(), HERE, hazards(row()));
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
