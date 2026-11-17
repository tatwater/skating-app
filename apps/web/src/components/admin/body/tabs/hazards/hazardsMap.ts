import { isBrowsableSeason, type Season } from '@skating/core';

import type { BodyMapScene, MapOutline, MapPoint } from '../../map/mapDescriptors';
import { drawingOf, type Shaped } from './hazardDrawing';
import { featureTypeLabel, hazardTypeLabel, kindOf } from './hazardsModel';
import { CROSSING_WORDS, SHAPE_WORDS } from './hazardsWords';

/**
 * What the Hazards tab asks the frame's map to draw (board 5.4.7): every hazard's footprint and
 * every known feature's, on the Hazards and Features layers — and Hazards opens with both on.
 * **No clocks on the map** (Review 13): a hazard is its dot field there, dimmed by freshness and
 * never removed; a known feature draws exactly as a hazard does, at full strength, with no key. A
 * shape the map can't draw is a pin at about where it was reported, said as *shape unknown*
 * (`drawingOf`, the one rule the rows ask too).
 *
 * **The winter on screen is in the lit address**, so the map draws the winter the list shows and a
 * reload keeps it: `winter:<year>` while a past winter is chosen and nothing in it is lit, and a
 * hazard in a past winter as `hazard:<year>.<id>`. The current winter needs neither — the tab opens
 * on it, empty or not, and a past one is shown only by choosing it.
 */

export type HazardsMapData = {
  /** The winter these hazards are from, and the winter it is now. */
  season: Season;
  current: Season;
  hazards: readonly (Shaped & {
    /** Core's hazard type: a crossing draws its own mark, never a danger field (`hazardKind`). */
    type: string;
    freshness: 'fresh' | 'aging' | 'stale';
    provisional: boolean;
    healingState?: string | undefined;
  })[];
  /** Each feature's type names its pin, should its shape not be drawable. */
  features: readonly (Shaped & { type?: string | undefined })[];
};

/**
 * The address a hazard answers to on `?lit=`: bare in the current winter, carrying its winter in a
 * past one, so lighting it never moves the list or the map back to now.
 */
export const hazardLit = (id: string, season?: Season, current?: Season) =>
  season === undefined || season === current ? `hazard:${id}` : `hazard:${season}.${id}`;
/**
 * A known feature's address: like a hazard's, it carries the winter on screen when that is a past
 * one, so lighting a feature while a past winter is shown keeps that winter (a feature has no
 * winter of its own, but the list and the map beside it do).
 */
export const featureLit = (id: string, season?: Season, current?: Season) =>
  season === undefined || season === current ? `feature:${id}` : `feature:${season}.${id}`;

/** A chosen winter with nothing in it lit: `null` for the current one, which needs no address. */
export const winterLit = (season: Season, current: Season): string | null =>
  season === current ? null : `winter:${season}`;

/**
 * The winter a lit address is in: a chosen past winter, a past winter's hazard or feature, or now.
 * A year the server wouldn't browse (it reads such a season as this one) is now, too, so a crafted
 * address never labels this winter's hazards as another's.
 */
export function seasonOfLit(lit: string | null | undefined, current: Season): Season {
  const m = /^(?:winter:(\d{4})$|(?:hazard|feature):(\d{4})\.)/.exec(lit ?? '');
  const year = Number(m?.[1] ?? m?.[2]);
  return isBrowsableSeason(year) && year <= current ? year : current;
}

export function hazardsMapScene(data: HazardsMapData, lit: string | null): BodyMapScene {
  const items: (MapOutline | MapPoint)[] = [];
  for (const f of data.features) {
    const drawing = drawingOf(f);
    if (drawing.kind === 'nowhere') continue;
    const id = featureLit(f._id, data.season, data.current);
    // A known feature has no clock: full strength, drawn exactly as a hazard is.
    const field = { freshness: 'known', tone: 'hazard', provisional: false } as const;
    items.push(
      drawing.kind === 'footprint'
        ? {
            kind: 'outline',
            id,
            layer: 'features',
            style: 'footprint',
            geometry: drawing.area,
            field,
          }
        : {
            kind: 'point',
            id,
            layer: 'features',
            at: drawing.at,
            mark: 'feature',
            ...(f.type === undefined ? {} : { name: featureTypeLabel(f.type) }),
            caption: SHAPE_WORDS.unknown,
            field,
          },
    );
  }
  for (const h of data.hazards) {
    const drawing = drawingOf(h);
    if (drawing.kind === 'nowhere') continue;
    const id = hazardLit(h._id, data.season, data.current);
    if (kindOf(h.type) === 'crossing') {
      // A report that someone crossed there: its own mark (two bars, never the danger triangle or
      // field), named plainly — never as a way across that is safe (D3). A mark at a point whatever
      // its shape, so a crossing with no drawable shape is drawn the same.
      items.push({
        kind: 'point',
        id,
        layer: 'hazards',
        at: drawing.at,
        mark: 'passage',
        name: CROSSING_WORDS.label,
      });
      continue;
    }
    const healing = h.healingState === 'healing_unsafe';
    const field = {
      freshness: h.freshness,
      tone: healing ? 'healing' : 'hazard',
      provisional: h.provisional,
    } as const;
    if (drawing.kind === 'footprint') {
      items.push({
        kind: 'outline',
        id,
        layer: 'hazards',
        style: 'footprint',
        geometry: drawing.area,
        field,
      });
      continue;
    }
    // **No drawable shape: a pin at about where it was reported** (the founder, 2026-11-17). Never
    // a lesser hazard (D3): the hazard's own mark at full face, at exactly the fade its field would
    // have had, its words saying the *shape* is unknown — never the hazard.
    items.push({
      kind: 'point',
      id,
      layer: 'hazards',
      at: drawing.at,
      mark: healing ? 'healing' : 'hazard',
      name: hazardTypeLabel(h.type),
      caption: SHAPE_WORDS.unknown,
      field,
    });
  }
  const mine = lit !== null && items.some((i) => i.id === lit);
  return { items, lit: mine ? lit : null, layers: { hazards: true, features: true } };
}
