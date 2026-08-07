/**
 * **Two rows of the corpus, side by side, field by field** — the evidence a dedup merge is decided on.
 *
 * The merge queue used to render a name and a button. That is enough when a duplicate is a
 * user-drawn pond over an OSM lake (D36's original case, where "which is official" answers it), and
 * it is useless for what the queue actually holds after N7: pairs of **OSM features that OSM cannot
 * see are the same lake** — 37 of the first 100 with no name at all, so the card read as a blank box
 * above a button labelled `Merge →`. Nothing on screen distinguished one pair from the next, and a
 * merge is not reversible in the way a rejection is.
 *
 * So this builds the comparison table instead: every stored attribute that could bear on "are these
 * one lake, and if so which row survives", each one flagged as agreeing or disagreeing. The UI
 * defaults to showing **only the disagreements**, because that is the whole judgement — two rows that
 * differ in nothing but their `osmId` are trivially a duplicate, and two that differ in area by 4×
 * are trivially not.
 *
 * ## Why absence is not agreement
 *
 * A field neither body holds is `empty` and never `differs`: a shared silence is not evidence. A
 * field **one** body holds is a disagreement, and an important one — `nhdId` present on one side and
 * absent on the other is exactly the reconciliation state that produced the flag.
 *
 * ## Formatting lives here, not in the component
 *
 * Every cell is already a string by the time it leaves this module, so the table is dumb and the
 * rounding is tested. Areas are **acres** because the corpus's admission rule is written in acres
 * (D91's floor, and every ETL log line), and lengths are **metres** because the question a moderator
 * is answering — "is this the same outline?" — is one that 812 m against 815 m answers and 0.50 mi
 * against 0.50 mi hides. That is a deliberate departure from D25's imperial display, and it is
 * confined to this operator surface.
 */

import type { BBox, LatLng } from './geometry';
import { haversineMeters } from './geometry';
import { waterBodyClassLabel } from './types';
import { formatAreaAcres } from './units';

/**
 * One side of the comparison — a `waterBodies` row minus the heavy geometry.
 *
 * Structurally typed against the Convex document rather than imported from it: `@skating/core` sits
 * below the backend and cannot depend on the generated data model. Every field is optional except
 * the four the schema makes required, so a caller can hand over a partial projection.
 */
export interface ComparableBody {
  _id: string;
  name: string;
  type: string;
  source: string;
  geometrySource?: string;
  states?: readonly string[];
  surfaceAreaSqM?: number;
  sourceAreaSqM?: number;
  shorelineM?: number;
  longAxisM?: number;
  shortAxisM?: number;
  longAxisBearingDeg?: number;
  elevationM?: number;
  elevationSource?: string;
  meanDepthM?: number;
  maxDepthM?: number;
  meanDepthSource?: string;
  maxDepthSource?: string;
  inRegionFraction?: number;
  externalId?: string;
  osmId?: string;
  nhdId?: string;
  gnisId?: string;
  threeDhpId?: string;
  waterBodyKey?: string;
  confidence?: { name: string; polygon: string; cls: string };
  reviewReasons?: readonly string[];
  lastCampaignId?: string;
  includedByRequest?: boolean;
  curatedBoost?: number;
  displayScore?: number;
  minVisibleZoom?: number;
  centroid: LatLng;
  bbox: BBox;
  dedupStatus: string;
  reviewStatus?: string;
  removedAt?: number;
  mergedIntoId?: string;
  createdAt: number;
}

/** Which block of the table a row belongs to, in the order an operator reads them. */
export const COMPARE_SECTIONS = [
  'identity',
  'geometry',
  'profile',
  'display',
  'lifecycle',
] as const;
export type CompareSection = (typeof COMPARE_SECTIONS)[number];

export const COMPARE_SECTION_LABELS: Readonly<Record<CompareSection, string>> = {
  identity: 'Identity',
  geometry: 'Shape & size',
  profile: 'Profile',
  display: 'Display',
  lifecycle: 'Lifecycle',
};

/** One attribute across every body in the group. */
export interface CompareRow {
  key: string;
  label: string;
  section: CompareSection;
  /** One cell per body, in the order the bodies were given. `null` means "nothing stored". */
  values: (string | null)[];
  /** The bodies disagree — including "one holds it, the other doesn't". */
  differs: boolean;
  /** Nobody holds a value. Never `differs`; a shared silence is not evidence. */
  empty: boolean;
}

/** What the two rows say about each other — the numbers no single row can hold. */
export interface PairAgreement {
  /** Polygon intersection-over-union, `null` when it could not be computed. */
  iou: number | null;
  centroidDistanceM: number;
  /** `larger / smaller`, `null` when either side has no area. */
  areaRatio: number | null;
}

const UNNAMED = '(unnamed)';

/** The name to show for a body, since a third of this queue has none. */
export function bodyLabel(body: Pick<ComparableBody, 'name'>): string {
  return body.name.trim() === '' ? UNNAMED : body.name;
}

function metres(value: number | undefined): string | null {
  return value === undefined ? null : `${Math.round(value).toLocaleString('en-US')} m`;
}

function acres(value: number | undefined): string | null {
  return value === undefined ? null : formatAreaAcres(value);
}

function coord(point: LatLng | undefined): string | null {
  return point === undefined ? null : `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}

function withSource(value: string | null, source: string | undefined): string | null {
  if (value === null) return null;
  return source === undefined ? value : `${value} · ${source}`;
}

/** The width of a body's bbox at its own latitude, and its height — a cheap "same footprint?" check. */
function bboxExtentM(box: BBox): { widthM: number; heightM: number } {
  const midLat = (box.minLat + box.maxLat) / 2;
  return {
    widthM: haversineMeters({ lat: midLat, lng: box.minLng }, { lat: midLat, lng: box.maxLng }),
    heightM: haversineMeters(
      { lat: box.minLat, lng: box.minLng },
      { lat: box.maxLat, lng: box.minLng },
    ),
  };
}

interface FieldSpec {
  key: string;
  label: string;
  section: CompareSection;
  read: (body: ComparableBody) => string | null;
}

/**
 * The table, in reading order.
 *
 * Identity first because it is what settles the commonest case in this queue — the same lake carried
 * twice by one catalogue, where both rows hold an `osmId` and only one holds the `nhdId` that proved
 * they were one thing. Lifecycle last because it decides the *survivor* rather than the *verdict*.
 */
const FIELDS: readonly FieldSpec[] = [
  {
    key: 'name',
    label: 'Name',
    section: 'identity',
    read: (b) => (b.name.trim() === '' ? null : b.name),
  },
  { key: 'type', label: 'Class', section: 'identity', read: (b) => waterBodyClassLabel(b.type) },
  { key: 'source', label: 'Imported from', section: 'identity', read: (b) => b.source },
  {
    key: 'geometrySource',
    label: 'Outline drawn from',
    section: 'identity',
    // Absent means "the same as `source`" (schema), so it is stated rather than left blank —
    // a blank here would read as a disagreement with a body that happens to store the field.
    read: (b) => b.geometrySource ?? b.source,
  },
  { key: 'osmId', label: 'OSM id', section: 'identity', read: (b) => b.osmId ?? null },
  { key: 'nhdId', label: 'NHD id', section: 'identity', read: (b) => b.nhdId ?? null },
  { key: 'threeDhpId', label: '3DHP id', section: 'identity', read: (b) => b.threeDhpId ?? null },
  { key: 'gnisId', label: 'GNIS id', section: 'identity', read: (b) => b.gnisId ?? null },
  {
    key: 'externalId',
    label: 'Upsert key',
    section: 'identity',
    read: (b) => b.externalId ?? null,
  },
  {
    key: 'waterBodyKey',
    label: 'Our key',
    section: 'identity',
    read: (b) => b.waterBodyKey ?? null,
  },
  {
    key: 'states',
    label: 'States',
    section: 'identity',
    read: (b) => (b.states?.length ? [...b.states].join(', ') : null),
  },

  {
    key: 'surfaceAreaSqM',
    label: 'Area (stored)',
    section: 'geometry',
    read: (b) => acres(b.surfaceAreaSqM),
  },
  {
    key: 'sourceAreaSqM',
    label: 'Area (as published)',
    section: 'geometry',
    read: (b) => acres(b.sourceAreaSqM),
  },
  { key: 'shorelineM', label: 'Shoreline', section: 'geometry', read: (b) => metres(b.shorelineM) },
  { key: 'longAxisM', label: 'Long axis', section: 'geometry', read: (b) => metres(b.longAxisM) },
  {
    key: 'shortAxisM',
    label: 'Short axis',
    section: 'geometry',
    read: (b) => metres(b.shortAxisM),
  },
  {
    key: 'bearing',
    label: 'Long-axis bearing',
    section: 'geometry',
    read: (b) =>
      b.longAxisBearingDeg === undefined ? null : `${Math.round(b.longAxisBearingDeg)}°`,
  },
  {
    key: 'centroid',
    label: 'Representative point',
    section: 'geometry',
    read: (b) => coord(b.centroid),
  },
  {
    key: 'bbox',
    label: 'Bounding box',
    section: 'geometry',
    read: (b) => {
      const { widthM, heightM } = bboxExtentM(b.bbox);
      return `${Math.round(widthM).toLocaleString('en-US')} × ${Math.round(heightM).toLocaleString('en-US')} m`;
    },
  },
  {
    key: 'inRegionFraction',
    label: 'Inside our states',
    section: 'geometry',
    read: (b) =>
      b.inRegionFraction === undefined ? null : `${Math.round(b.inRegionFraction * 100)}%`,
  },

  {
    key: 'meanDepthM',
    label: 'Mean depth',
    section: 'profile',
    read: (b) =>
      withSource(b.meanDepthM === undefined ? null : `${b.meanDepthM} m`, b.meanDepthSource),
  },
  {
    key: 'maxDepthM',
    label: 'Max depth',
    section: 'profile',
    read: (b) =>
      withSource(b.maxDepthM === undefined ? null : `${b.maxDepthM} m`, b.maxDepthSource),
  },
  {
    key: 'elevationM',
    label: 'Elevation',
    section: 'profile',
    read: (b) =>
      withSource(
        b.elevationM === undefined ? null : `${Math.round(b.elevationM)} m`,
        b.elevationSource,
      ),
  },
  {
    key: 'confidence',
    label: 'Confidence (name / outline / class)',
    section: 'profile',
    read: (b) =>
      b.confidence === undefined
        ? null
        : `${b.confidence.name} / ${b.confidence.polygon} / ${b.confidence.cls}`,
  },
  {
    key: 'reviewReasons',
    label: 'Flagged for review because',
    section: 'profile',
    read: (b) => (b.reviewReasons?.length ? [...b.reviewReasons].join(', ') : null),
  },

  {
    key: 'displayScore',
    label: 'Display score',
    section: 'display',
    read: (b) => (b.displayScore === undefined ? null : b.displayScore.toFixed(2)),
  },
  {
    key: 'minVisibleZoom',
    label: 'Draws from',
    section: 'display',
    read: (b) => (b.minVisibleZoom === undefined ? null : `z${b.minVisibleZoom}`),
  },
  {
    key: 'curatedBoost',
    label: 'Curated boost',
    section: 'display',
    read: (b) => (b.curatedBoost === undefined ? null : b.curatedBoost.toFixed(1)),
  },

  { key: 'dedupStatus', label: 'Dedup status', section: 'lifecycle', read: (b) => b.dedupStatus },
  {
    key: 'reviewStatus',
    label: 'Review status',
    section: 'lifecycle',
    read: (b) => b.reviewStatus ?? null,
  },
  {
    key: 'lastCampaignId',
    label: 'Last campaign',
    section: 'lifecycle',
    read: (b) => b.lastCampaignId ?? null,
  },
  {
    key: 'includedByRequest',
    label: 'Kept by request',
    section: 'lifecycle',
    read: (b) => (b.includedByRequest === true ? 'yes' : null),
  },
  {
    key: 'createdAt',
    label: 'First imported',
    section: 'lifecycle',
    read: (b) => new Date(b.createdAt).toISOString().slice(0, 10),
  },
  {
    key: 'removedAt',
    label: 'Delisted',
    section: 'lifecycle',
    read: (b) =>
      b.removedAt === undefined ? null : new Date(b.removedAt).toISOString().slice(0, 10),
  },
  {
    key: 'mergedIntoId',
    label: 'Already merged into',
    section: 'lifecycle',
    read: (b) => b.mergedIntoId ?? null,
  },
];

/**
 * Every attribute of every body in the group, as a table.
 *
 * Rows nobody holds are still returned (marked `empty`) rather than dropped — "neither of these has
 * a depth on record" is a fact the operator may want, and filtering is the caller's decision. The
 * caller that wants the short version filters on `differs`.
 */
export function compareBodies(bodies: readonly ComparableBody[]): CompareRow[] {
  return FIELDS.map((field) => {
    const values = bodies.map((body) => field.read(body));
    const empty = values.every((v) => v === null);
    const first = values[0];
    return {
      key: field.key,
      label: field.label,
      section: field.section,
      values,
      differs: !empty && values.some((v) => v !== first),
      empty,
    };
  });
}

/** How many attributes the bodies actually disagree on — the headline number on a queue card. */
export function differingFieldCount(rows: readonly CompareRow[]): number {
  return rows.filter((r) => r.differs).length;
}

/**
 * A plain-English read on how alike two outlines are, for the line above the table.
 *
 * Deliberately never says "duplicate" or "not a duplicate": IoU is the signal that *flagged* the
 * pair, so restating it as a verdict would be the machine grading its own homework in the one place
 * a human was asked to look. It describes the geometry and stops.
 */
export function describeAgreement(agreement: PairAgreement): string {
  const parts: string[] = [];
  if (agreement.iou !== null) parts.push(`${Math.round(agreement.iou * 100)}% overlap`);
  parts.push(
    agreement.centroidDistanceM < 1000
      ? `centres ${Math.round(agreement.centroidDistanceM)} m apart`
      : `centres ${(agreement.centroidDistanceM / 1000).toFixed(1)} km apart`,
  );
  if (agreement.areaRatio !== null) {
    parts.push(
      agreement.areaRatio < 1.005
        ? 'same area'
        : `one is ${agreement.areaRatio.toFixed(2)}× the other`,
    );
  }
  return parts.join(' · ');
}
