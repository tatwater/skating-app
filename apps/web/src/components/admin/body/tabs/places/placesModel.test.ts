import { describe, expect, it } from 'vitest';

import { MASCOMA_PLACES } from './placesFixtures';
import {
  acres,
  askKicker,
  formatDistance,
  formatPoint,
  kindWord,
  landmarkRows,
  type PlaceNameAsk,
  type ProposalAsk,
  parseExternalId,
  placeAsks,
  placesMapDrawing,
  selectedLandmark,
} from './placesModel';

const editorRow = (over: Record<string, unknown> = {}) => ({
  _id: 'lm1',
  name: 'Upper Shaker Village',
  kind: 'settlement' as const,
  point: { lat: 43.6117, lng: -72.1381 },
  aliases: ['Shaker Village'],
  source: 'osm',
  externalIds: ['osm:node/158821324', 'gnis:870595'],
  subAreaId: 'bay-s',
  ...over,
});

describe('landmarkRows', () => {
  it('reads catalogs and ids from the external ids, and the bay by name', () => {
    const [row] = landmarkRows([editorRow()], new Map([['bay-s', 'Mascoma South']]));
    expect(row).toMatchObject({
      catalogs: ['OSM', 'GNIS'],
      ids: [
        { catalog: 'OSM', id: 'node/158821324' },
        { catalog: 'GNIS', id: '870595' },
      ],
      bay: 'Mascoma South',
      areaSqM: null,
      added: null,
    });
  });

  it('leaves removed rows out, falls back to the source word, and has no bay until bays are read', () => {
    const rows = landmarkRows(
      [
        editorRow({ _id: 'gone', removedAt: 1 }),
        editorRow({ _id: 'mod', source: 'moderator', externalIds: [], subAreaId: undefined }),
        editorRow({ _id: 'other-bay', subAreaId: 'bay-x' }),
      ],
      null,
    );
    expect(rows.map((r) => [r.id, r.catalogs, r.bay])).toEqual([
      ['mod', ['MODERATOR'], null],
      ['other-bay', ['OSM', 'GNIS'], null],
    ]);
  });

  it('orders by the list’s word, then name', () => {
    const rows = landmarkRows(
      [
        editorRow({ _id: 'a', name: 'Zed', kind: 'waterway' }),
        editorRow({ _id: 'b', name: 'Camp', kind: 'establishment' }),
        editorRow({ _id: 'c', name: 'Alpha', kind: 'waterway' }),
      ],
      null,
    );
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('the words', () => {
  it('gives each kind one word on the list', () => {
    expect(kindWord('waterway')).toBe('River');
    expect(kindWord('establishment')).toBe('Camp');
    expect(kindWord('settlement')).toBe('Town');
  });

  it('parses a prefixed id, and keeps an unprefixed one whole', () => {
    expect(parseExternalId('osm:way/4432891#out1')).toEqual({
      catalog: 'OSM',
      id: 'way/4432891#out1',
    });
    expect(parseExternalId('12345')).toEqual({ catalog: '', id: '12345' });
  });

  it('says an ask’s kind and count', () => {
    const [name, proposal] = MASCOMA_PLACES.asks as [PlaceNameAsk, ProposalAsk];
    expect(askKicker(name)).toBe('Place name · 12 emails');
    expect(askKicker({ ...proposal, askers: 3 })).toBe('Proposal · 3 skaters');
    expect(askKicker({ ...name, messages: 1 })).toBe('Place name · 1 email');
  });

  it('writes distances in tenths of a mile, or feet when closer', () => {
    expect(formatDistance(333)).toBe('0.2 mi');
    expect(formatDistance(1609.344 * 1.25)).toBe('1.3 mi');
    expect(formatDistance(100)).toBe('328 ft');
  });

  it('writes a point with four decimals and a real minus sign, and acres to a tenth', () => {
    expect(formatPoint({ lat: 43.61171, lng: -72.13809 })).toBe('43.6117, −72.1381');
    expect(formatPoint({ lat: -1, lng: 2 })).toBe('−1.0000, 2.0000');
    expect(acres(4046.8564224 * 10.24)).toBe('10.2');
  });
});

describe('placeAsks', () => {
  it('puts the most-mentioned emailed names first, then the proposals with what they may be', () => {
    const asks = placeAsks(
      [
        { _id: 'n1', name: 'The Cove', messages: 2 },
        { _id: 'n2', name: 'the Narrows', messages: 12, alreadyNamed: true },
        { _id: 'n3', name: 'Beta', messages: 2 },
      ],
      [
        {
          requestId: 'r1',
          name: 'the flats',
          coord: { lat: 1, lng: 2 },
          askers: 1,
          similarLandmark: { landmarkId: 'l', name: 'Dam', point: { lat: 1, lng: 2 }, meters: 3 },
        },
        {
          requestId: 'r2',
          name: 'Pier',
          coord: { lat: 1, lng: 2 },
          askers: 2,
          existingLandmarkId: 'l2',
        },
      ],
    );
    expect(asks.map((a) => a.id)).toEqual(['n2', 'n3', 'n1', 'r1', 'r2']);
    expect(asks[0]).toMatchObject({ alreadyNamed: true });
    expect(asks[1]).toMatchObject({ alreadyNamed: false });
    expect(asks[3]).toMatchObject({
      asker: null,
      existingLandmarkId: null,
      similar: { name: 'Dam' },
    });
    expect(asks[4]).toMatchObject({ existingLandmarkId: 'l2', similar: null });
  });
});

describe('selection and the map', () => {
  it('selects a live landmark by its lit id, and nothing else', () => {
    expect(selectedLandmark(MASCOMA_PLACES, 'landmark:lm-upper')?.name).toBe(
      'Upper Shaker Village',
    );
    expect(selectedLandmark(MASCOMA_PLACES, 'landmark:gone')).toBeNull();
    expect(selectedLandmark(MASCOMA_PLACES, 'ask:ask-flats')).toBeNull();
    expect(selectedLandmark(MASCOMA_PLACES, null)).toBeNull();
    expect(selectedLandmark(undefined, 'landmark:lm-upper')).toBeNull();
  });

  it('draws every landmark and proposal, the lit and hovered ones marked, with the proposal’s key', () => {
    const d = placesMapDrawing(MASCOMA_PLACES, 'landmark:lm-upper', 'landmark:lm-dam');
    expect(d.points).toHaveLength(17);
    const upper = d.points.find((p) => p.id === 'landmark:lm-upper');
    expect(upper).toMatchObject({ lit: true, hovered: false, slug: 'TOWN · OSM · GNIS' });
    expect(d.points.find((p) => p.id === 'landmark:lm-dam')).toMatchObject({ hovered: true });
    expect(d.points.find((p) => p.mark === 'proposal')).toMatchObject({ id: 'ask:ask-flats' });
    expect(d.key).toEqual([{ mark: 'proposal', label: 'Proposed by a skater' }]);
    expect([d.lit, d.hovered]).toEqual(['landmark:lm-upper', 'landmark:lm-dam']);
  });

  it('has no key without a proposal, and lights nothing that isn’t on the map', () => {
    const d = placesMapDrawing({ asks: [], landmarks: MASCOMA_PLACES.landmarks }, 'ask:x');
    expect(d.key).toEqual([]);
    expect(d.lit).toBeNull();
    expect(d.hovered).toBeNull();
  });
});
