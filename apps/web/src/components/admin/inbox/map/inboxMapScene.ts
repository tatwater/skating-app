import type { BBoxLike } from '@/lib/mapSurface';
import type {
  BodyMapLayer,
  BodyMapScene,
  LngLat,
  MapItem,
  MapLineStyle,
  MapOutlineStyle,
  MapRaster,
} from '../../body/map/mapDescriptors';
import { formatDistance } from '../../body/tabs/places/placesModel';
import {
  frameBox,
  growBox,
  metersBetween,
  midpoint,
  nearestVertices,
  outlineCoords,
} from './inboxMapFrame';
import { INBOX_MAP_WORDS as W } from './inboxMapWords';

/**
 * **What an Inbox item's embed draws** — one pure builder per board shape, from a handler's facts
 * to the console map's scene (`body/map/mapDescriptors`) plus the box the camera frames and fences
 * on, the legend's rows and a caption. The handlers adapt the server's item views to these minimal
 * inputs (plain coordinates, GeoJSON, names); nothing here reads Convex.
 *
 * - 2.1 {@link reportPointScene} — a flagged report's point on its body: the red reticle for a
 *   safety item, the bright one otherwise.
 * - 2.2 {@link accessScene} — a body with its access points (an access report carries no point:
 *   it is about the body).
 * - 2.3 {@link admitScene} — a catalog candidate, the asks' skates, the nearest body of ours and
 *   the distance to it; with no candidate, the asked points.
 * - 2.4 {@link lookalikeScene} — the asked point, its lookalikes, and the distance to the nearest.
 * - 2.5 {@link drawnScene} — a skater's drawing over the body it overlaps, and the skate.
 * - 2.6 {@link alertScene} — an access alert's put-in or lot, lit, among the body's others.
 *
 * Ids are the descriptors' addresses (`body:<id>`, `putIn:<id>`), so a handler can light one.
 */

// ── Inputs: the handler builders code against these ──────────────────────────────────────────

/** A body (ours, or a catalog's candidate, or a skater's drawing): its outline and its name. */
export interface EmbedBody {
  id: string;
  name: string;
  outline: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

/** A point somebody filed or a place on the map. */
export interface EmbedPoint {
  id: string;
  at: LngLat;
  /** What the hover plate names it. */
  name?: string;
}

/** A put-in or a lot. */
export interface EmbedAccessPoint extends EmbedPoint {
  kind: 'putIn' | 'lot';
}

/** A path: a recorded skate, a lot's walk to its put-in. */
export interface EmbedPath {
  id: string;
  path: readonly LngLat[];
}

/**
 * An archived satellite pass of the body (the Body console's Aerial layer, Imagery's frames): drawn
 * under the outlines by the console map's own reveal. The archive holds passes for our active
 * bodies only — a catalog candidate has none until it is admitted.
 */
export type AerialPass = Pick<MapRaster, 'key' | 'granuleId' | 'band' | 'capturedAt' | 'season'>;

/** Every builder takes an optional one-line caption for the embed's corner. */
interface Captioned {
  /** Written capitalized ("Report point · town beach"); set as a kicker in the plate's corner. */
  caption?: string;
}

// ── Output ───────────────────────────────────────────────────────────────────────────────────

/** A legend row: its words and the stroke it names, by the map's own style (never a color). */
export interface InboxLegendRow {
  label: string;
  stroke: { kind: 'outline'; style: MapOutlineStyle } | { kind: 'line'; style: MapLineStyle };
}

export interface InboxMapView {
  /** What the camera frames — and fences the operator to, unless a wider `reach` is given. */
  frame: BBoxLike;
  /** Where the operator may pan and zoom out to, if wider than the frame (2.4's whole body). */
  reach: BBoxLike | null;
  scene: BodyMapScene;
  /** The legend plate's rows (2.3, 2.5); none draws no plate. */
  legend: readonly InboxLegendRow[];
  caption: string | null;
}

// ── Pieces ───────────────────────────────────────────────────────────────────────────────────

const bodyItem = (b: EmbedBody, style: MapOutlineStyle, prefix = 'body'): MapItem => ({
  kind: 'outline',
  id: `${prefix}:${b.id}`,
  layer: 'outline',
  geometry: b.outline,
  style,
});

const accessItem = (p: EmbedAccessPoint, kicker?: string): MapItem => ({
  kind: 'point',
  id: `${p.kind}:${p.id}`,
  layer: 'putIns',
  at: p.at,
  mark: p.kind,
  ...(p.name === undefined ? {} : { name: p.name }),
  hoverKicker: kicker ?? (p.kind === 'lot' ? W.lot : W.putIn),
});

const trackItem = (t: EmbedPath): MapItem => ({
  kind: 'line',
  id: `track:${t.id}`,
  layer: 'tracks',
  path: t.path,
  style: 'track',
});

/** The body's archived pass, under everything the embed draws (the Aerial layer). */
const aerialItem = (p: AerialPass): MapItem => ({
  kind: 'raster',
  id: `aerial:${p.granuleId}`,
  layer: 'aerial',
  ...p,
});

/**
 * The corner caption: the handler's line, then the fact the board letters on the map beside the
 * subject — under the legend, where it never lies over the outline it is about.
 */
const captionWith = (caption: string | undefined, fact: string | undefined) =>
  [caption, fact].filter((t): t is string => t !== undefined).join(' · ') || undefined;

/** A point somebody asked about: the bright reticle. */
const askedItem = (a: EmbedPoint): MapItem => ({
  kind: 'point',
  id: `ask:${a.id}`,
  layer: 'marks',
  at: a.at,
  mark: 'asked',
  hoverKicker: W.asked,
  ...(a.name === undefined ? {} : { name: a.name }),
});

/** A distance rule between two points, and its length set into it. */
function gapItems(id: string, from: LngLat, to: LngLat): MapItem[] {
  return [
    { kind: 'line', id: `gap:${id}`, layer: 'marks', path: [from, to], style: 'gap' },
    {
      kind: 'label',
      id: `gap:${id}:length`,
      layer: 'marks',
      at: midpoint(from, to),
      text: formatDistance(metersBetween(from, to)),
      style: 'measure',
    },
  ];
}

/** The scene, with every layer an item belongs to switched on — an embed has no rack to do it. */
function sceneOf(items: readonly MapItem[], lit: string | null = null): BodyMapScene {
  const layers: Partial<Record<BodyMapLayer, boolean>> = {};
  for (const i of items) layers[i.layer] = true;
  return { items, lit, layers };
}

function view(
  items: readonly MapItem[],
  framed: readonly LngLat[],
  extra: {
    lit?: string | null;
    legend?: readonly InboxLegendRow[];
    caption?: string;
    /** Room around a subject of a few points, as a share of its own size on each side. */
    grow?: number;
    /** Points the operator may pan to beyond the frame (with the frame, their box is the reach). */
    reach?: readonly LngLat[];
  },
): InboxMapView {
  if (framed.length === 0) throw new Error('An embed needs something to frame.');
  const box = frameBox(framed as [LngLat, ...LngLat[]]);
  const frame = extra.grow ? growBox(box, extra.grow) : box;
  const reach =
    extra.reach && extra.reach.length > 0
      ? frameBox([[frame.minLng, frame.minLat], [frame.maxLng, frame.maxLat], ...extra.reach])
      : null;
  return {
    frame,
    reach,
    scene: sceneOf(items, extra.lit ?? null),
    legend: extra.legend ?? [],
    caption: extra.caption ?? null,
  };
}

/** Legend rows in the board's order, for the labels the handler gave and the items drawn. */
function legendRows(
  rows: readonly (readonly [label: string | undefined, drawn: boolean, InboxLegendRow['stroke']])[],
): InboxLegendRow[] {
  return rows.flatMap(([label, drawn, stroke]) =>
    label !== undefined && drawn ? [{ label, stroke }] : [],
  );
}

// ── 2.1 ──────────────────────────────────────────────────────────────────────────────────────

export interface ReportPointInput extends Captioned {
  /** The body the report is on; `null` when it is on none we hold. */
  body: EmbedBody | null;
  /** Where the report was made. */
  report: EmbedPoint;
  /** A safety item (the Safety lane): the reticle is the hazard red. */
  safety: boolean;
}

export function reportPointScene({
  body,
  report,
  safety,
  caption,
}: ReportPointInput): InboxMapView {
  const items: MapItem[] = [];
  if (body) items.push(bodyItem(body, 'body'));
  items.push({
    kind: 'point',
    id: `report:${report.id}`,
    layer: 'marks',
    at: report.at,
    mark: safety ? 'reticle' : 'asked',
    hoverKicker: W.reportPoint,
    name: report.name ?? body?.name ?? W.reportPoint,
  });
  return view(items, [report.at, ...(body ? outlineCoords(body.outline) : [])], { caption });
}

// ── 2.2 ──────────────────────────────────────────────────────────────────────────────────────

export interface AccessInput extends Captioned {
  body: EmbedBody;
  /** The body's put-ins and lots. */
  access: readonly EmbedAccessPoint[];
  /** The walks from lots to put-ins, as the Body console's Access tab routes them. */
  approaches?: readonly EmbedPath[];
}

export function accessScene({ body, access, approaches = [], caption }: AccessInput): InboxMapView {
  const items: MapItem[] = [
    bodyItem(body, 'body'),
    ...approaches.map(
      (a): MapItem => ({
        kind: 'line',
        id: `walk:${a.id}`,
        layer: 'putIns',
        path: a.path,
        style: 'approach',
      }),
    ),
    ...access.map((p) => accessItem(p)),
  ];
  return view(items, [...outlineCoords(body.outline), ...access.map((p) => p.at)], { caption });
}

// ── 2.3 ──────────────────────────────────────────────────────────────────────────────────────

export interface AdmitInput extends Captioned {
  /** The catalog's feature the asks matched; `null` when nothing matched (only the asks to show). */
  candidate: EmbedBody | null;
  /**
   * Where each asker asked (every stored ask carries its point). With no candidate there must be
   * at least one: the frame needs something to hold.
   */
  asks: readonly EmbedPoint[];
  /** The skates the asks came with. */
  tracks?: readonly EmbedPath[];
  /** The nearest body of ours, if the catalog block names one: drawn, with the distance to it. */
  nearest?: EmbedBody | null;
  /** The legend's words for what is drawn; a row shows only for a label given. */
  legend?: { candidate?: string; track?: string; nearest?: string };
  /**
   * The catalog's fact the board letters beside the candidate ("Unnamed · 41 ac"): the corner's
   * caption, after the handler's own, while a candidate is drawn.
   */
  candidateFact?: string;
  /** A pass to draw under it (the Aerial switch, on by default): only an admitted body has one. */
  aerial?: AerialPass | null;
}

export function admitScene({
  candidate,
  asks,
  tracks = [],
  nearest = null,
  legend = {},
  candidateFact,
  aerial = null,
  caption,
}: AdmitInput): InboxMapView {
  const items: MapItem[] = aerial ? [aerialItem(aerial)] : [];
  const framed: LngLat[] = [...asks.map((a) => a.at), ...tracks.flatMap((t) => t.path)];
  if (nearest) items.push(bodyItem(nearest, 'neighbor'));
  if (candidate) {
    items.push(bodyItem(candidate, 'candidate', 'candidate'));
    framed.push(...outlineCoords(candidate.outline));
  }
  items.push(...tracks.map(trackItem));
  // With a candidate its outline is the subject and the asks' points add nothing; without one, the
  // points are all there is.
  if (!candidate)
    for (const a of asks)
      items.push({
        kind: 'point',
        id: `ask:${a.id}`,
        layer: 'marks',
        at: a.at,
        mark: 'asked',
        hoverKicker: W.asked,
        ...(a.name === undefined ? {} : { name: a.name }),
      });
  if (nearest) {
    // From the candidate's shore, or — with none — from the nearest of the asked points.
    const from: GeoJSON.Polygon | GeoJSON.MultiPolygon = candidate
      ? candidate.outline
      : { type: 'Polygon', coordinates: [asks.map((a) => [...a.at])] };
    const pair = nearestVertices(from, nearest.outline);
    if (pair) {
      items.push(...gapItems(`nearest:${nearest.id}`, pair[0], pair[1]));
      framed.push(pair[0], pair[1]);
    }
  }
  return view(items, framed, {
    caption: captionWith(caption, candidate === null ? undefined : candidateFact),
    legend: legendRows([
      [legend.candidate, candidate !== null, { kind: 'outline', style: 'candidate' }],
      [legend.track, tracks.length > 0, { kind: 'line', style: 'track' }],
      [legend.nearest, nearest !== null, { kind: 'outline', style: 'neighbor' }],
    ]),
  });
}

/** A request on a body we hold (activate, restore, contest access, takedown): the body, the asks. */
export interface RequestOnBodyInput extends Captioned {
  body: EmbedBody;
  asks: readonly EmbedPoint[];
}

export function requestOnBodyScene({ body, asks, caption }: RequestOnBodyInput): InboxMapView {
  return view(
    [bodyItem(body, 'body'), ...asks.map(askedItem)],
    [...outlineCoords(body.outline), ...asks.map((a) => a.at)],
    { caption },
  );
}

// ── 2.4 ──────────────────────────────────────────────────────────────────────────────────────

export interface LookalikeInput extends Captioned {
  /** The body the ask is on (drawn, not framed: the frame is the two points). */
  body: EmbedBody | null;
  asked: EmbedPoint;
  /** Places that may be the one asked about; the nearest gets the distance rule. */
  lookalikes: readonly EmbedPoint[];
  /** The same place asked by others too (a bay several people asked for): drawn and framed. */
  alsoAsked?: readonly EmbedPoint[];
}

export function lookalikeScene({
  body,
  asked,
  lookalikes,
  alsoAsked = [],
  caption,
}: LookalikeInput): InboxMapView {
  const items: MapItem[] = [];
  if (body) items.push(bodyItem(body, 'body'));
  items.push(...alsoAsked.map(askedItem));
  const byDistance = [...lookalikes].sort(
    (a, b) => metersBetween(asked.at, a.at) - metersBetween(asked.at, b.at),
  );
  const nearest = byDistance[0];
  if (nearest) items.push(...gapItems(`lookalike:${nearest.id}`, asked.at, nearest.at));
  for (const l of byDistance)
    items.push({
      kind: 'point',
      id: `lookalike:${l.id}`,
      layer: 'marks',
      at: l.at,
      mark: 'lookalike',
      hoverKicker: W.lookalike,
      ...(l.name === undefined ? {} : { name: l.name }),
    });
  items.push({
    kind: 'point',
    id: `ask:${asked.id}`,
    layer: 'marks',
    at: asked.at,
    mark: 'asked',
    hoverKicker: W.asked,
    ...(asked.name === undefined ? {} : { name: asked.name }),
  });
  // Framed on the two points with the board's room around them (the middle third), so the body's
  // shape reads around the question; the operator may still pan and zoom out over the whole body.
  return view(items, [asked.at, ...alsoAsked.map((a) => a.at), ...lookalikes.map((l) => l.at)], {
    caption,
    grow: 1,
    reach: body ? outlineCoords(body.outline) : [],
  });
}

// ── 2.5 ──────────────────────────────────────────────────────────────────────────────────────

export interface DrawnInput extends Captioned {
  /** The body of ours the drawing overlaps; `null` for a drawing over open land. */
  body: EmbedBody | null;
  drawing: EmbedBody;
  /** The recorded skate the drawing came from. */
  track?: EmbedPath | null;
  legend?: { body?: string; drawing?: string; track?: string };
  /**
   * The overlap fact the board letters at the drawing's edge ("8 % on the shore"): the corner's
   * caption, after the handler's own.
   */
  drawingFact?: string;
  /** The body's pass to draw under it (the Aerial switch, on by default). */
  aerial?: AerialPass | null;
}

export function drawnScene({
  body,
  drawing,
  track = null,
  legend = {},
  drawingFact,
  aerial = null,
  caption,
}: DrawnInput): InboxMapView {
  const items: MapItem[] = aerial ? [aerialItem(aerial)] : [];
  const framed: LngLat[] = [...outlineCoords(drawing.outline), ...(track?.path ?? [])];
  if (body) {
    items.push(bodyItem(body, 'body'));
    framed.push(...outlineCoords(body.outline));
  }
  items.push(bodyItem(drawing, 'candidate', 'drawn'));
  if (track) items.push(trackItem(track));
  return view(items, framed, {
    caption: captionWith(caption, drawingFact),
    legend: legendRows([
      [legend.body, body !== null, { kind: 'outline', style: 'body' }],
      [legend.drawing, true, { kind: 'outline', style: 'candidate' }],
      [legend.track, track !== null, { kind: 'line', style: 'track' }],
    ]),
  });
}

// ── 2.6 ──────────────────────────────────────────────────────────────────────────────────────

export interface AlertInput extends Captioned {
  body: EmbedBody | null;
  /**
   * The put-in or lot the alert is about: lit (the brackets), and named in the corner's caption
   * unless the handler gives one — a lit mark's standing plate would run off a narrow embed's edge.
   */
  target: EmbedAccessPoint;
  /** The body's other access points, drawn plainly. */
  others?: readonly EmbedAccessPoint[];
}

export function alertScene({ body, target, others = [], caption }: AlertInput): InboxMapView {
  const items: MapItem[] = [];
  if (body) items.push(bodyItem(body, 'body'));
  for (const o of others)
    if (o.id !== target.id || o.kind !== target.kind) items.push(accessItem(o));
  // Unnamed on the map, so lighting it raises no standing plate; its hover plate says what it is.
  const { name, ...unnamed } = target;
  const lit = accessItem(unnamed, target.kind === 'lot' ? W.alertLot : W.alertPutIn);
  items.push(lit);
  return view(
    items,
    [target.at, ...others.map((o) => o.at), ...(body ? outlineCoords(body.outline) : [])],
    // The put-in's or lot's name leads; a caption (the handler's, or the map's own note on a
    // short answer) follows it — never in its place.
    { caption: captionWith(name, caption), lit: lit.id },
  );
}
