/**
 * Board 5.4.2's Mascoma Lake (dev relation/4056603), as the Names tab draws it. Constants only —
 * reached from stories and tests, never the app (`fixturesStayInStories.test.ts`).
 */
import type { NamesData } from './namesModel';

/** The board: three catalogs, one spelling each; the class the catalogs dispute; two towns. */
export const MASCOMA_NAMES: NamesData = {
  name: 'Mascoma Lake',
  rungs: [
    { value: 'Mascoma Lake', sources: ['nhd', 'gnis'], now: true },
    { value: 'Mascoma Lake', sources: ['3dhp'], now: false },
    { value: 'Mascoma Lake', sources: ['osm'], now: false },
  ],
  community: false,
  overridden: false,
  aliases: [],
  cls: 'reservoir',
  classOptions: [
    { cls: 'reservoir', sources: ['OSM', '3DHP'] },
    { cls: 'lakePond', sources: ['NHD'], note: 'fcode 390' },
  ],
  perCatalogClaims: 'kept',
  failures: [],
  place: {
    admin: { towns: ['Enfield', 'Lebanon'], counties: ['Grafton'] },
    states: ['NH'],
    townLines: [
      {
        id: 'canaan-enfield',
        faces: ['Canaan', 'Enfield'],
        path: [
          { lng: -72.0617, lat: 43.62544 },
          { lng: -72.14877, lat: 43.65413 },
          { lng: -72.16041, lat: 43.65852 },
        ],
      },
      {
        id: 'lebanon-enfield',
        faces: ['Lebanon', 'Enfield'],
        path: [
          { lng: -72.16041, lat: 43.65852 },
          { lng: -72.18175, lat: 43.62768 },
          { lng: -72.20831, lat: 43.58521 },
        ],
      },
    ],
  },
};

/**
 * The same body as the app reads it today: one stored claim (the import keeps one source per
 * spelling), no class claims, the towns and county from the boundaries, no town lines.
 */
export const MASCOMA_NAMES_AS_READ: NamesData = {
  ...MASCOMA_NAMES,
  rungs: [{ value: 'Mascoma Lake', sources: ['nhd'], now: true }],
  classOptions: null,
  perCatalogClaims: null,
  place: {
    admin: { towns: ['Enfield', 'Lebanon'], counties: ['Grafton County'] },
    states: ['NH'],
    townLines: null,
  },
};

/** Two catalogs disagree on the spelling, and a moderator chose the losing one. */
export const AUBURN_NAMES: NamesData = {
  name: 'Lake Auburn',
  rungs: [
    { value: 'The Basin', sources: ['nhd', 'gnis'], now: false },
    { value: 'Lake Auburn', sources: ['osm'], now: true },
  ],
  community: false,
  overridden: true,
  aliases: ['Auburn Lake'],
  cls: 'lakePond',
  classOptions: null,
  perCatalogClaims: null,
  place: {
    admin: { towns: ['Auburn'], counties: ['Androscoggin'] },
    states: ['ME'],
    townLines: null,
  },
  failures: [],
};

/** A pond no catalog named, which skaters call Low Plains. */
export const LOW_PLAINS_NAMES: NamesData = {
  name: 'Low Plains',
  rungs: [],
  community: true,
  overridden: true,
  aliases: [],
  cls: 'lakePond',
  classOptions: null,
  perCatalogClaims: null,
  // Computed, and no boundary holds it: in no town or county.
  place: { admin: { towns: [], counties: [] }, states: ['NH'], townLines: null },
  failures: [],
};
