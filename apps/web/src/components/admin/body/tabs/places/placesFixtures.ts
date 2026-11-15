/**
 * Board 5.4.3's Mascoma Lake (dev relation/4056603, the 29 Sep landmark pass), as the Places tab
 * draws it. Constants only — reached from stories and tests, never the app.
 */
import type { LandmarkKind } from '@skating/core';

import type { LandmarkRow, PlacesData } from './placesModel';

const N = 'Mascoma North';
const S = 'Mascoma South';
/** 29 Sep 2026 at local midday: the landmark pass. */
const PASS = new Date(2026, 8, 29, 12).getTime();

const row = (
  id: string,
  kind: LandmarkKind,
  name: string,
  catalogs: string[],
  ids: string[],
  point: [number, number],
  bay: string | null,
  areaSqM: number | null = null,
): LandmarkRow => ({
  id,
  name,
  kind,
  point: { lat: point[0], lng: point[1] },
  aliases: [],
  catalogs,
  ids: ids.map((raw) => {
    const [catalog = '', rest = ''] = raw.split(':');
    return { catalog: catalog.toUpperCase(), id: rest };
  }),
  bay,
  areaSqM,
  added: { at: PASS, by: 'By the landmark pass' },
});

export const MASCOMA_LANDMARKS: LandmarkRow[] = [
  row(
    'lm-shakoma',
    'beach',
    'Shakoma Beach',
    ['OSM'],
    ['osm:way/1003119105'],
    [43.6306, -72.1574],
    N,
    1380,
  ),
  row('lm-bridge', 'bridge', 'Shaker Bridge', ['OSM'], ['osm:way/4571222'], [43.6293, -72.1561], S),
  row(
    'lm-camp',
    'establishment',
    'Mascoma Lake Campground',
    ['OSM'],
    ['osm:way/865343749'],
    [43.6414, -72.1597],
    N,
    44927,
  ),
  row('lm-dam', 'dam', 'Mascoma Lake Dam', ['OSM'], ['osm:way/768393630'], [43.6497, -72.1798], N),
  row(
    'lm-north',
    'island',
    'North Island',
    ['OSM'],
    ['osm:way/4554184'],
    [43.6188, -72.1366],
    S,
    13653,
  ),
  row(
    'lm-relham',
    'island',
    'Relham Island',
    ['OSM'],
    ['osm:way/4554183'],
    [43.6166, -72.1342],
    S,
    12498,
  ),
  row(
    'lm-wood',
    'island',
    'Wood Island',
    ['OSM', 'GNIS'],
    ['osm:way/715586283', 'gnis:2571346'],
    [43.6228, -72.14],
    S,
    4258,
  ),
  row('lm-black', 'point', 'Black Point', ['GNIS'], ['gnis:2571345'], [43.615, -72.131], S),
  row(
    'lm-knox',
    'waterway',
    'Knox River',
    ['OSM'],
    ['osm:way/1127621009#in0'],
    [43.609, -72.129],
    S,
  ),
  row(
    'lm-inlet',
    'waterway',
    'Mascoma River (inlet)',
    ['OSM'],
    ['osm:way/4432891#in0'],
    [43.6122, -72.125],
    S,
  ),
  row(
    'lm-outlet',
    'waterway',
    'Mascoma River (outlet)',
    ['OSM'],
    ['osm:way/4432891#out1'],
    [43.6499, -72.1806],
    N,
  ),
  row(
    'lm-smith',
    'waterway',
    'Smith Pond Brook',
    ['OSM'],
    ['osm:way/1127613434#in0'],
    [43.6098, -72.1372],
    S,
  ),
  row('lm-enfield', 'settlement', 'Enfield', ['GNIS'], ['gnis:866802'], [43.6406, -72.144], null),
  row(
    'lm-lower',
    'settlement',
    'Lower Shaker Village',
    ['OSM', 'GNIS'],
    ['osm:node/158821549', 'gnis:868205'],
    [43.6224, -72.1462],
    S,
  ),
  row('lm-mascoma', 'settlement', 'Mascoma', ['GNIS'], ['gnis:868292'], [43.6521, -72.1804], null),
  row(
    'lm-upper',
    'settlement',
    'Upper Shaker Village',
    ['OSM', 'GNIS'],
    ['osm:node/158821324', 'gnis:870595'],
    [43.6117, -72.1381],
    S,
  ),
];

export const MASCOMA_PLACES: PlacesData = {
  asks: [
    {
      kind: 'place-name',
      id: 'ask-narrows',
      name: 'the Narrows',
      messages: 12,
      alreadyNamed: false,
    },
    {
      kind: 'proposal',
      id: 'ask-flats',
      name: 'the flats by the dam',
      point: { lat: 43.6468, lng: -72.1787 },
      askers: 1,
      // First asked at local midday, so the date reads the same in every zone.
      asked: new Date(2026, 9, 11, 12).getTime(),
      asker: { name: 'Kate Donovan', handle: 'kdonovan', href: '/admin/users/u-kdonovan' },
      existingLandmarkId: null,
      similar: {
        landmarkId: 'lm-dam',
        name: 'Mascoma Lake Dam',
        point: { lat: 43.6497, lng: -72.1798 },
        meters: 333,
      },
    },
  ],
  asksCapped: false,
  landmarks: MASCOMA_LANDMARKS,
  failures: [],
};

/** The board's hovered row (clear ground at the lake's north end). */
export const HOVERED_DAM = 'landmark:lm-dam';
/** Board 5.4.3 | Landmark's selection. */
export const SELECTED_UPPER = 'landmark:lm-upper';
