import { describe, expect, it } from 'vitest';
import { isFailed } from '@/components/admin/reads/consoleReads';
import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
import { MASCOMA_PLACES } from './placesFixtures';
import {
  ADDED_BY,
  acres,
  addedByLandmark,
  askersByRequest,
  askKicker,
  formatDistance,
  formatPoint,
  kindWord,
  landmarkRows,
  litId,
  type PlaceAsk,
  type PlaceNameAsk,
  type PlacesData,
  type PlacesReads,
  type ProposalAsk,
  parseExternalId,
  personFrom,
  placeAsks,
  placesFrom,
  placesMapScene,
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
    const [row] = landmarkRows([editorRow()], new Map([['bay-s', 'Mascoma South']]), new Map());
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

  it('leaves removed rows out, falls back to the source word, and has the bay in its read’s state', () => {
    const rows = (bays: Parameters<typeof landmarkRows>[1]) =>
      landmarkRows(
        [
          editorRow({ _id: 'gone', removedAt: 1 }),
          editorRow({ _id: 'mod', source: 'moderator', externalIds: [], subAreaId: undefined }),
          editorRow({ _id: 'other-bay', subAreaId: 'bay-x' }),
        ],
        bays,
        new Map(),
      ).map((r) => [r.id, r.catalogs, r.bay]);
    // A landmark in no bay is in none, whatever the bays' read says.
    expect(rows(undefined)).toEqual([
      ['mod', ['MODERATOR'], null],
      ['other-bay', ['OSM', 'GNIS'], undefined],
    ]);
    expect(rows(FAILED_READ)[1]?.[2]).toBe(FAILED_READ);
    // A bay the read doesn't hold (removed since) is none.
    expect(rows(new Map())[1]?.[2]).toBeNull();
    // A name is never a failure, whatever it spells.
    expect(rows(new Map([['bay-x', 'failed']]))[1]?.[2]).toBe('failed');
    expect(rows(new Map([['bay-x', 'failed']]))[1]?.[2]).not.toBe(FAILED_READ);
  });

  it('orders by the list’s word, then name', () => {
    const rows = landmarkRows(
      [
        editorRow({ _id: 'a', name: 'Zed', kind: 'waterway' }),
        editorRow({ _id: 'b', name: 'Camp', kind: 'establishment' }),
        editorRow({ _id: 'c', name: 'Alpha', kind: 'waterway' }),
      ],
      undefined,
      undefined,
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
  it('carries when each proposal was first asked, and says when the read doesn’t', () => {
    const at = new Date(2026, 10, 3, 12).getTime();
    const asks = placeAsks(
      [],
      [
        { requestId: 'r1', name: 'the flats', coord: { lat: 1, lng: 2 }, askers: 1, createdAt: at },
        { requestId: 'r2', name: 'Pier', coord: { lat: 1, lng: 2 }, askers: 1 },
      ],
      'hidden',
    );
    expect(asks[0]).toMatchObject({ asked: at });
    expect(asks[1]).toMatchObject({ asked: null });
  });

  it('puts the most-mentioned emailed names first, then the proposals with what they may be', () => {
    const asks = placeAsks(
      [
        { _id: 'n1', name: 'The Cove', messages: 2 },
        { _id: 'n2', name: 'the Narrows', messages: 12, alreadyNamed: true, aliases: ['Narrows'] },
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
          aliases: ['The pier'],
          coord: { lat: 1, lng: 2 },
          askers: 2,
          existingLandmarkId: 'l2',
        },
      ],
      'hidden',
    );
    expect(asks.map((a) => a.id)).toEqual(['n2', 'n3', 'n1', 'r1', 'r2']);
    expect(asks[0]).toMatchObject({ alreadyNamed: true, aliases: ['Narrows'] });
    expect(asks[1]).toMatchObject({ alreadyNamed: false, aliases: [] });
    expect(asks[3]).toMatchObject({
      asker: 'hidden',
      existingLandmarkId: null,
      similar: { name: 'Dam' },
    });
    expect(asks[4]).toMatchObject({
      existingLandmarkId: 'l2',
      similar: null,
      aliases: ['The pier'],
    });
    expect(asks[3]).toMatchObject({ aliases: [] });
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

  it('adds each proposal as proposed, and keeps a lit landmark the frame draws', () => {
    const scene = placesMapScene(MASCOMA_PLACES, 'landmark:lm-upper');
    expect(scene.items).toEqual([
      {
        kind: 'point',
        id: 'landmarkAsk:ask-flats',
        layer: 'marks',
        at: [-72.1787, 43.6468],
        mark: 'proposal',
        name: 'the flats by the dam',
        hoverKicker: 'Proposed by a skater',
      },
    ]);
    expect(scene.lit).toBe('landmark:lm-upper');
    expect(placesMapScene(MASCOMA_PLACES, 'landmarkAsk:ask-flats').lit).toBe(
      'landmarkAsk:ask-flats',
    );
  });

  it('lights nothing that isn’t on the map: an emailed name, a gone landmark', () => {
    expect(placesMapScene(MASCOMA_PLACES, 'placeName:ask-narrows').lit).toBeNull();
    expect(placesMapScene(MASCOMA_PLACES, 'landmark:gone').lit).toBeNull();
    expect(placesMapScene({ ...MASCOMA_PLACES, asks: [], landmarks: [] }, null)).toEqual({
      items: [],
      lit: null,
    });
  });

  it('draws nothing of a list still loading or failed, and lights nothing in it', () => {
    for (const state of [undefined, FAILED_READ] as const) {
      const data: PlacesData = { ...MASCOMA_PLACES, asks: state, landmarks: state };
      expect(placesMapScene(data, 'landmark:lm-upper')).toEqual({ items: [], lit: null });
      expect(selectedLandmark(data, 'landmark:lm-upper')).toBeNull();
    }
  });

  it('addresses each ask the way the left column links it', () => {
    const [name, proposal] = MASCOMA_PLACES.asks as [PlaceNameAsk, ProposalAsk];
    expect([litId.ask(name), litId.ask(proposal)]).toEqual([
      'placeName:ask-narrows',
      'landmarkAsk:ask-flats',
    ]);
  });
});

const KATE = { userId: 'u1', username: 'kdonovan', displayName: 'Kate Donovan' };
/** 29 Sep 2026 at local midday. */
const PASS = new Date(2026, 8, 29, 12).getTime();

describe('people and provenance', () => {
  it('names a person by their real name, the handle as the link to their page', () => {
    expect(personFrom(KATE)).toEqual({
      name: 'Kate Donovan',
      handle: 'kdonovan',
      href: '/admin/people/u1',
    });
    // No real name on record: the handle stands in, never a blank.
    expect(personFrom({ ...KATE, displayName: '  ' }).name).toBe('kdonovan');
  });

  it('says who added a landmark: the moderator who placed it, else what its source was', () => {
    const added = addedByLandmark([
      { landmarkId: 'a', source: 'moderator', createdAt: PASS, createdBy: KATE },
      { landmarkId: 'b', source: 'osm', createdAt: PASS, createdBy: null },
      { landmarkId: 'c', source: 'corpus', createdAt: PASS, createdBy: null },
      { landmarkId: 'd', source: 'someday', createdAt: PASS, createdBy: null },
    ]);
    expect(added.get('a')).toEqual({ at: PASS, by: personFrom(KATE), edited: null, merged: null });
    expect(added.get('b')?.by).toBe(ADDED_BY.osm);
    expect(added.get('c')?.by).toBe('From the community’s emails');
    expect(added.get('d')?.by).toBe('someday');
  });

  it('keeps when a moderator last edited and a merge last changed each landmark — nothing the read returns is dropped', () => {
    const added = addedByLandmark([
      {
        landmarkId: 'a',
        source: 'osm',
        createdAt: PASS,
        createdBy: null,
        moderatorEditedAt: PASS + 1,
        movedAt: PASS + 2,
      },
    ]);
    expect(added.get('a')).toMatchObject({ edited: PASS + 1, merged: PASS + 2 });
  });

  it('never reads the edit stamp a moderator’s landmark gets as it is made as an edit', () => {
    const added = addedByLandmark([
      {
        landmarkId: 'a',
        source: 'moderator',
        createdAt: PASS,
        createdBy: KATE,
        moderatorEditedAt: PASS,
        movedAt: null,
      },
    ]);
    expect(added.get('a')).toMatchObject({ edited: null, merged: null });
  });

  it('marks an erased asker as erased, never as nobody', () => {
    const askers = askersByRequest([
      { requestId: 'r1', requester: KATE },
      { requestId: 'r2', requester: null },
    ]);
    expect(askers.get('r1')).toEqual(personFrom(KATE));
    expect(askers.get('r2')).toBe('erased');
  });
});

describe('placesFrom', () => {
  const reads = (over: Partial<PlacesReads> = {}): PlacesReads => ({
    landmarks: [editorRow({ _id: 'lm1' })],
    bays: [{ _id: 'bay-s', name: 'Mascoma South' }],
    names: { names: [{ _id: 'n1', name: 'the Narrows', messages: 12 }], more: false },
    proposals: {
      proposals: [
        { requestId: 'r1', name: 'the flats', coord: { lat: 1, lng: 2 }, askers: 1 },
        { requestId: 'r9', name: 'the pier', coord: { lat: 1, lng: 2 }, askers: 1 },
      ],
      more: false,
    },
    provenance: [{ landmarkId: 'lm1', source: 'osm', createdAt: PASS, createdBy: null }],
    proposers: [{ requestId: 'r1', requester: KATE }],
    ...over,
  });

  it('draws every read that landed, with who asked and when each landmark was added', () => {
    const data = placesFrom(reads());
    expect(data.failures).toEqual([]);
    expect(data.asksCapped).toBe(false);
    const asks = data.asks as PlaceAsk[];
    expect(asks.map((a) => (a.kind === 'proposal' ? a.asker : a.kind))).toEqual([
      'place-name',
      personFrom(KATE),
      // An ask the proposers read didn't reach is not recorded, never erased.
      null,
    ]);
    expect(data.landmarks).toMatchObject([
      { id: 'lm1', bay: 'Mascoma South', added: { at: PASS, by: 'By the landmark pass' } },
    ]);
  });

  it('keeps each read’s own state: loading stays loading, a failure is named', () => {
    const loading = placesFrom(
      reads({ names: undefined, bays: undefined, provenance: undefined, proposers: undefined }),
    );
    expect(loading.asks).toBeUndefined();
    expect(loading.landmarks).toMatchObject([{ bay: undefined, added: undefined }]);
    expect(loading.failures).toEqual([]);

    const failed = placesFrom(
      reads({
        landmarks: FAILED_READ,
        proposals: FAILED_READ,
        bays: FAILED_READ,
        provenance: FAILED_READ,
        proposers: FAILED_READ,
      }),
    );
    // Two reads behind the asks: one failure for both.
    expect(isFailed(failed.asks)).toBe(true);
    expect(failed.landmarks).toBe(FAILED_READ);
    expect(failed.failures).toEqual([
      'the landmarks',
      'what is asked',
      'the bays',
      'when each landmark was added',
      'who asked',
    ]);

    // Who asked failing leaves the asks standing, each saying it.
    const askers = placesFrom(reads({ proposers: FAILED_READ }));
    expect((askers.asks as ProposalAsk[])[1]?.asker).toBe(FAILED_READ);
  });

  it('draws no askers at all for a viewer who can’t see them', () => {
    const data = placesFrom(reads({ proposers: 'hidden' }));
    const proposals = (data.asks as PlaceAsk[]).filter((a) => a.kind === 'proposal');
    expect(proposals.map((p) => p.asker)).toEqual(['hidden', 'hidden']);
    expect(data.failures).toEqual([]);
  });

  it('says the asks are a floor when either read stopped short', () => {
    const more = placesFrom(reads({ proposals: { proposals: [], more: true } }));
    expect(more.asksCapped).toBe(true);
    const full = placesFrom(reads({ names: { names: [], more: true } }));
    expect(full.asksCapped).toBe(true);
    // Both reads whole: no floor, however many names came back.
    expect(placesFrom(reads()).asksCapped).toBe(false);
  });
});
