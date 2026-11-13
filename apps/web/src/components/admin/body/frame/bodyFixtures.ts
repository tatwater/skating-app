import type { LandmarkKind } from '@skating/core';

import { type BodyMapBaseInput, bodyMapBase } from '../map/bodyMapBase';
import type { BodyMapScene } from '../map/mapDescriptors';
import {
  type BodyAsk,
  type BodyIdentity,
  type BodyRecord,
  bodyAsks,
  bodyHistory,
  bodyIdentity,
  type HistoryAction,
  type HistoryEntry,
} from './bodyModel';
import {
  MASCOMA_BBOX,
  MASCOMA_LANDMARKS,
  MASCOMA_NORTH,
  MASCOMA_POLYGON,
  MASCOMA_PUT_INS,
  MASCOMA_SOUTH,
} from './mascomaFixtures';

/**
 * Board 5.4.1's Mascoma Lake, as the Body console's reads would hand it over: the real dev outline
 * and places (`mascomaFixtures.ts`), the boards' figures, and the boards' day — Wednesday 14 October
 * 2026, day 10 of the watch, at local noon so a date reads the same in every zone. Story and test
 * support only: `fixturesStayInStories.test.ts` fails if the app reaches this file.
 */

/** 14 Oct 2026, 12:00 in the runner's own zone. */
export const BODY_NOW = new Date(2026, 9, 14, 12, 0).getTime();
const on = (month: number, day: number) => new Date(2026, month - 1, day, 12, 0).getTime();

export const MASCOMA_ID = 'j57mascoma0000000000000000000';

export const MASCOMA_RECORD: BodyRecord = {
  _id: MASCOMA_ID as BodyRecord['_id'],
  name: 'Mascoma Lake',
  nameClaims: [
    { source: 'nhd', value: 'Mascoma Lake' },
    { source: '3dhp', value: 'Mascoma Lake' },
    { source: 'osm', value: 'Mascoma Lake' },
  ],
  type: 'reservoir',
  source: 'osm',
  geometrySource: 'osm',
  osmId: 'relation/4056603',
  nhdId: '120802878',
  threeDhpId: 'JDYXT',
  gnisId: '868293',
  polygon: MASCOMA_POLYGON as BodyRecord['polygon'],
  surfaceAreaSqM: 4_623_575,
  shorelineM: 18_301,
  meanDepthM: 9.36,
  maxDepthM: 24.08,
  elevationM: 227.93,
  windRose: [0.1, 0.1, 0.1, 0.2, 0.2, 0.1, 0.1, 0.1],
  fetchProfileM: [3200, 2100, 900, 600],
  curatedBoost: 0.3,
  publicAccess: {
    verdict: 'open',
    decidedAt: on(9, 21),
    decidedByUserId: 'teagan' as never,
  },
  dedupStatus: 'clean',
  activatedAt: on(9, 17),
  createdAt: on(7, 1),
};

const TEAGAN = { displayName: 'Teagan Atwater', username: 'teagan' };
const MATT = { displayName: 'Matt Steinberg', username: 'matt' };

/** The body's audit rows, newest first — what `moderation.listActions` reads for it. */
export const MASCOMA_HISTORY: readonly HistoryAction[] = [
  {
    id: 'h5',
    action: 'set_reference_links',
    targetType: 'waterbody',
    createdAt: on(10, 10) + 3_600_000,
    actor: MATT,
  },
  {
    id: 'h4',
    action: 'set_public_access',
    targetType: 'waterbody',
    createdAt: on(9, 21),
    actor: TEAGAN,
  },
  {
    id: 'h3',
    action: 'set_curated_boost',
    targetType: 'waterbody',
    createdAt: on(9, 19),
    actor: TEAGAN,
  },
  {
    id: 'h2',
    action: 'activate_body',
    targetType: 'waterbody',
    createdAt: on(9, 17),
    actor: TEAGAN,
  },
  {
    id: 'h1',
    action: 'set_lake_depth',
    targetType: 'waterbody',
    createdAt: on(9, 12),
    actor: MATT,
  },
];

export const MASCOMA_IDENTITY: BodyIdentity = bodyIdentity(MASCOMA_RECORD, {
  history: MASCOMA_HISTORY,
  hasBathymetry: false,
  towns: ['Enfield, NH', 'Lebanon, NH'],
});

/** As the app reads it today: no read says the towns or the bathymetry yet. */
export const MASCOMA_IDENTITY_AS_READ: BodyIdentity = bodyIdentity(MASCOMA_RECORD, {
  history: MASCOMA_HISTORY,
  hasBathymetry: null,
  towns: null,
});

export const MASCOMA_ASKS: readonly BodyAsk[] = bodyAsks({
  bays: [
    {
      requestId: 'bayask1',
      name: 'Shaker cove',
      askers: 3,
      createdAt: on(10, 4),
      notes: ['Near the Shaker Bridge launch'],
    },
  ],
  placeNames: [{ _id: 'placename1', name: 'the Narrows', messages: 12 }],
  landmarks: [
    { requestId: 'lmask1', name: 'the flats by the dam', askers: 1, createdAt: on(10, 9) },
  ],
});

export const MASCOMA_HISTORY_ENTRIES: { entries: readonly HistoryEntry[]; capped: boolean } = {
  entries: bodyHistory(MASCOMA_HISTORY),
  capped: false,
};

/** A lot sits a few meters off its launch, as the dev lots do. */
const LOT_OFFSET = 0.0003;

export const MASCOMA_BASE_INPUT: BodyMapBaseInput = {
  bodyId: MASCOMA_ID,
  polygon: MASCOMA_POLYGON,
  bays: [
    { id: 'bay-north', name: 'Mascoma North', polygon: MASCOMA_NORTH },
    { id: 'bay-south', name: 'Mascoma South', polygon: MASCOMA_SOUTH },
  ],
  landmarks: MASCOMA_LANDMARKS.map((l, i) => ({
    id: `lm${i}`,
    name: l.name,
    kind: l.kind as LandmarkKind,
    point: { lat: l.lat, lng: l.lng },
    source: 'osm',
  })),
  putIns: MASCOMA_PUT_INS.map((p, i) => ({
    id: `p${i}`,
    coord: { lat: p.lat, lng: p.lng },
    ...(p.name !== null ? { name: p.name } : {}),
  })),
  lots: MASCOMA_PUT_INS.flatMap((p, i) =>
    p.lot ? [{ id: `l${i}`, coord: { lat: p.lat, lng: p.lng + LOT_OFFSET } }] : [],
  ),
  samplePoints: [],
};

export const MASCOMA_SCENE: BodyMapScene = bodyMapBase(MASCOMA_BASE_INPUT);

export const MASCOMA_BOUNDS = MASCOMA_BBOX;

/** The Shape tab's records. */
export const MASCOMA_SUB_AREAS = [
  { _id: 'bay-north', name: 'Mascoma North', surfaceAreaSqM: 2_476_700, removed: false },
  { _id: 'bay-south', name: 'Mascoma South', surfaceAreaSqM: 2_148_900, removed: false },
] as const;
