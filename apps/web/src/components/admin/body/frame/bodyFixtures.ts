import { AUDIT_REASON_MAX, type LandmarkKind } from '@skating/core';

import type { Completeness } from '../completeness';

import { type BodyMapBaseInput, bodyMapBase } from '../map/bodyMapBase';
import type { BodyMapScene } from '../map/mapDescriptors';
import {
  type BodyAsk,
  type BodyHistoryView,
  type BodyIdentity,
  type BodyRecord,
  bodyAsks,
  bodyHistory,
  bodyIdentity,
  type HistoryAction,
  type OutlineTrust,
  outlineTrust,
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
export const on = (month: number, day: number) => new Date(2026, month - 1, day, 12, 0).getTime();

export const MASCOMA_ID = 'j57mascoma0000000000000000000000';

/**
 * A removal's note near the cap `waterBodies.remove` holds it to (D261) — kept whole in the row's
 * metadata — and the row's sentence that quotes it, composed and so shortened to fit the same cap.
 */
export const REMOVAL_NOTE_NEAR_CAP = `${'The owner asked us to take it off the map: the gates are posted all winter and the launch is private. '.repeat(19)}Call the town office before anyone goes back out.`;
const REMOVED_FROM_MAP = 'Removed from map (landowner_request): ';
export const REMOVAL_SENTENCE_SHORTENED = `${REMOVED_FROM_MAP}${REMOVAL_NOTE_NEAR_CAP.slice(0, AUDIT_REASON_MAX - REMOVED_FROM_MAP.length - 1)}…`;

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
  meanDepthSource: 'state_agency',
  maxDepthSource: 'state_agency',
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

const BODY = 'waterbody' as const;

/**
 * The body's family's audit rows, newest first — what `bodyConsole.history` reads for it: the body
 * itself, and a landmark of its (the family's rows come with the body's).
 */
export const MASCOMA_HISTORY: readonly HistoryAction[] = [
  {
    id: 'h6',
    action: 'edit_landmark',
    targetType: 'bodyLandmark',
    targetId: 'lm0',
    createdAt: on(10, 12),
    actor: MATT,
  },
  {
    id: 'h5',
    action: 'set_reference_links',
    targetType: BODY,
    targetId: MASCOMA_ID,
    createdAt: on(10, 10) + 3_600_000,
    actor: MATT,
  },
  {
    id: 'h4',
    action: 'set_public_access',
    targetType: BODY,
    targetId: MASCOMA_ID,
    createdAt: on(9, 21),
    actor: TEAGAN,
  },
  {
    id: 'h3',
    action: 'set_curated_boost',
    targetType: BODY,
    targetId: MASCOMA_ID,
    createdAt: on(9, 19),
    actor: TEAGAN,
  },
  {
    id: 'h2',
    action: 'activate_body',
    targetType: BODY,
    targetId: MASCOMA_ID,
    createdAt: on(9, 17),
    actor: null,
  },
  {
    id: 'h1',
    action: 'set_lake_depth',
    targetType: BODY,
    targetId: MASCOMA_ID,
    createdAt: on(9, 12),
    actor: MATT,
  },
];

export const MASCOMA_IDENTITY: BodyIdentity = bodyIdentity(MASCOMA_RECORD, {
  history: MASCOMA_HISTORY,
});

/** The stored answer for Mascoma (board 5.4.1): nine of the ten, bathymetry missing. */
export const MASCOMA_COMPLETENESS: Completeness = { have: 9, of: 10, missing: ['bathymetry'] };

export const MASCOMA_TOWNS: readonly string[] = ['Enfield, NH', 'Lebanon, NH'];

/** `consoleExtras` for Mascoma: the 12 Oct campaign re-affirmed the outline; nothing touches it. */
export const MASCOMA_EXTRAS = {
  towns: ['Enfield', 'Lebanon'],
  // Each town with its own state, as the boundaries store it.
  townsWithState: [
    { name: 'Enfield', state: 'NH' },
    { name: 'Lebanon', state: 'NH' },
  ],
  // The library row's completeness (the frame's one field).
  complete: { have: 9, of: 10, missing: ['bathymetry'] },
  hasBathymetry: false,
  outlineTrustedSince: on(10, 12),
  outlineTrustedVia: 'campaign' as const,
  touchingBodyIds: [] as string[],
  touching: [] as { waterBodyId: string; name: string; ring: number[][] }[],
  touchingCapped: false,
  geoComputedAt: on(10, 12),
};

export const MASCOMA_TRUST: OutlineTrust | null = outlineTrust(MASCOMA_EXTRAS);

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

export const MASCOMA_HISTORY_ENTRIES: BodyHistoryView = {
  entries: bodyHistory(MASCOMA_HISTORY),
  capped: false,
};

/** A very large lake's history: the read stopped short, as it always does there. */
export const CAPPED_HISTORY: BodyHistoryView = {
  entries: bodyHistory(MASCOMA_HISTORY),
  capped: true,
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
  {
    _id: 'bay-north',
    name: 'Mascoma North',
    surfaceAreaSqM: 2_476_700,
    removed: false,
    createdAt: on(9, 2),
  },
  {
    _id: 'bay-south',
    name: 'Mascoma South',
    surfaceAreaSqM: 2_148_900,
    removed: false,
    createdAt: on(9, 2),
  },
] as const;

/** How Mascoma's two bays were made: seeded on 2 Sep by Teagan (`bodyConsole.bayProvenance`). */
export const MASCOMA_BAY_PROVENANCE = MASCOMA_SUB_AREAS.map((s) => ({
  subAreaId: s._id as never,
  createdAt: s.createdAt,
  createdVia: 'seed' as const,
  createdBy: { userId: 'teagan' as never, username: 'teagan', displayName: 'Teagan Atwater' },
}));

/** A body that touches Mascoma, for the Merge block and the map's neighbor (a made-up pond). */
export const NEIGHBOR_ID = 'k57neighbor00000000000000000000';
export const NEIGHBOR_POLYGON: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-72.168, 43.66],
      [-72.16, 43.66],
      [-72.16, 43.666],
      [-72.168, 43.666],
      [-72.168, 43.66],
    ],
  ],
};
