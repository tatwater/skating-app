import { describe, expect, it } from 'vitest';
import {
  alertsForBody,
  formatAlertLine,
  isSkatingRelevantAlert,
  type NwsAlert,
  nwsSeverityRank,
  zoneIdFromUri,
} from './nwsAlerts';

function alert(over: Partial<NwsAlert> = {}): NwsAlert {
  return {
    id: 'urn:oid:1',
    event: 'Winter Storm Warning',
    severity: 'Severe',
    zones: ['VTZ001'],
    states: ['VT'],
    ...over,
  };
}

describe('nwsSeverityRank', () => {
  it('orders NWS’s own vocabulary', () => {
    expect(nwsSeverityRank('Extreme')).toBeGreaterThan(nwsSeverityRank('Severe'));
    expect(nwsSeverityRank('Severe')).toBeGreaterThan(nwsSeverityRank('Minor'));
  });

  it('sorts an unrecognised level last rather than throwing', () => {
    expect(nwsSeverityRank('Catastrophic')).toBe(-1);
  });
});

describe('isSkatingRelevantAlert', () => {
  it.each([
    'Winter Storm Warning',
    'Ice Storm Warning',
    'Extreme Cold Warning',
    'Wind Chill Advisory',
    'High Wind Warning',
    'Blizzard Warning',
    'Lakeshore Flood Advisory',
    'Freezing Rain Advisory',
  ])('shows %s', (event) => {
    expect(isSkatingRelevantAlert({ event })).toBe(true);
  });

  it.each([
    'Red Flag Warning',
    'Air Quality Alert',
    'Rip Current Statement',
    'Heat Advisory',
  ])('hides %s, because a strip nobody trusts is worse than no strip', (event) => {
    expect(isSkatingRelevantAlert({ event })).toBe(false);
  });
});

describe('alertsForBody', () => {
  it('falls to the state rung when a body has no zone stamp', () => {
    const matched = alertsForBody({ states: ['VT'] }, [
      alert({ id: 'a', states: ['VT'] }),
      alert({ id: 'b', states: ['NH'] }),
    ]);
    expect(matched.map((a) => a.id)).toEqual(['a']);
  });

  /**
   * The ladder's load-bearing rule: a stamped body uses zones *instead of* the state, not as well
   * as. Merging would discard the precision while appearing to have used it.
   */
  it('uses the zone rung outright when stamped, ignoring the state rung', () => {
    const matched = alertsForBody({ states: ['VT'], nwsZoneIds: ['VTZ001'] }, [
      alert({ id: 'in-zone', zones: ['VTZ001'], states: ['VT'] }),
      alert({ id: 'same-state-other-zone', zones: ['VTZ099'], states: ['VT'] }),
    ]);
    expect(matched.map((a) => a.id)).toEqual(['in-zone']);
  });

  it('treats an empty zone array as unstamped and falls back', () => {
    const matched = alertsForBody({ states: ['VT'], nwsZoneIds: [] }, [
      alert({ id: 'a', zones: ['VTZ099'], states: ['VT'] }),
    ]);
    expect(matched.map((a) => a.id)).toEqual(['a']);
  });

  it('matches a county (SAME/FIPS) id as readily as a forecast zone', () => {
    const matched = alertsForBody({ states: ['VT'], nwsZoneIds: ['VTC007'] }, [
      alert({ id: 'by-county', zones: ['VTC007'], states: ['VT'] }),
    ]);
    expect(matched.map((a) => a.id)).toEqual(['by-county']);
  });

  it('orders most severe first, with a stable tie-break', () => {
    const matched = alertsForBody({ states: ['VT'] }, [
      alert({ id: 'z-minor', severity: 'Minor' }),
      alert({ id: 'a-extreme', severity: 'Extreme' }),
      alert({ id: 'b-severe', severity: 'Severe' }),
      alert({ id: 'a-severe', severity: 'Severe' }),
    ]);
    expect(matched.map((a) => a.id)).toEqual(['a-extreme', 'a-severe', 'b-severe', 'z-minor']);
  });

  it('matches a border body on either of its states', () => {
    const matched = alertsForBody({ states: ['NY', 'VT'] }, [
      alert({ id: 'ny', states: ['NY'] }),
      alert({ id: 'me', states: ['ME'] }),
    ]);
    expect(matched.map((a) => a.id)).toEqual(['ny']);
  });

  it('returns nothing for a body with no states at all', () => {
    expect(alertsForBody({}, [alert()])).toEqual([]);
  });
});

describe('zoneIdFromUri', () => {
  it('takes the bare id off an affectedZones URI', () => {
    expect(zoneIdFromUri('https://api.weather.gov/zones/forecast/VTZ001')).toBe('VTZ001');
  });

  it('returns null for something with no last segment', () => {
    expect(zoneIdFromUri('')).toBeNull();
    expect(zoneIdFromUri('https://api.weather.gov/zones/forecast/')).toBeNull();
  });
});

describe('formatAlertLine', () => {
  it('names the event and the area, in NWS’s words', () => {
    expect(formatAlertLine(alert({ areaDesc: 'Northern Vermont' }))).toBe(
      'Winter Storm Warning — Northern Vermont',
    );
  });

  it('falls back to the event alone', () => {
    expect(formatAlertLine(alert())).toBe('Winter Storm Warning');
  });
});

describe('cross-state alerts (Greptile P1, 2026-08-10)', () => {
  /**
   * The cache stores one row per (state, alert) so a state can be replaced on its own. A warning
   * covering VT and NH is therefore two rows sharing one `alertId` — and Lake Champlain, the most
   * prominent body in the corpus, spans two states.
   */
  it('renders a multi-state warning once, not once per state', () => {
    const matched = alertsForBody({ states: ['NY', 'VT'] }, [
      alert({ id: 'urn:oid:storm', states: ['VT'], areaDesc: 'Northern Vermont' }),
      alert({ id: 'urn:oid:storm', states: ['NY'], areaDesc: 'Eastern New York' }),
    ]);
    expect(matched).toHaveLength(1);
  });

  it('still keeps genuinely different alerts that share a state', () => {
    const matched = alertsForBody({ states: ['VT'] }, [
      alert({ id: 'urn:oid:storm', states: ['VT'] }),
      alert({ id: 'urn:oid:windchill', event: 'Wind Chill Advisory', states: ['VT'] }),
    ]);
    expect(matched).toHaveLength(2);
  });

  it('dedupes on the zone rung too, where one alert lists several of a body’s zones', () => {
    const matched = alertsForBody({ states: ['VT'], nwsZoneIds: ['VTZ001', 'VTZ002'] }, [
      alert({ id: 'urn:oid:storm', zones: ['VTZ001'], states: ['VT'] }),
      alert({ id: 'urn:oid:storm', zones: ['VTZ002'], states: ['VT'] }),
    ]);
    expect(matched).toHaveLength(1);
  });
});
