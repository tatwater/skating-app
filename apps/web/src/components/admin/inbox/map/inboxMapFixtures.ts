import type { BBoxLike } from '@/lib/mapSurface';
import { MASCOMA_POLYGON } from '../../body/frame/mascomaFixtures';
import type { LngLat } from '../../body/map/mapDescriptors';
import type {
  AccessInput,
  AdmitInput,
  AlertInput,
  DrawnInput,
  EmbedBody,
  LookalikeInput,
  ReportPointInput,
} from './inboxMapScene';

/**
 * The Inbox boards' maps as a handler would hand them over. 2.1 stands on Mascoma Lake's real dev
 * outline; the others' bodies aren't in the repo, so their shapes are **the boards' own drawings**
 * (`inbox-handler-v5.html`'s normalized lake arrays, smoothed as the board smooths them) laid on a
 * box at the real body's place, sized from the board's scale bar — so a story frames and measures
 * as the board does. Story and test support only (`fixturesStayInStories.test.ts`).
 */

/** The board's box for a drawing: its `[fx, fy]` (0–1 of the board's map, y down) land in here. */
type BoardBox = BBoxLike;

const place =
  (box: BoardBox) =>
  ([fx, fy]: readonly [number, number]): LngLat => [
    box.minLng + fx * (box.maxLng - box.minLng),
    box.maxLat - fy * (box.maxLat - box.minLat),
  ];

/** The board's `smooth()`: a closed Catmull-Rom through the points, six steps a segment. */
function smoothRing(pts: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  const n = pts.length;
  const at = (i: number) => pts[((i % n) + n) % n] as readonly [number, number];
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < 6; s++) {
      const t = s / 6;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (a: number, b: number, d: number, e: number) =>
        0.5 *
        (2 * b + (-a + d) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (-a + 3 * b - 3 * d + e) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

function boardBody(
  id: string,
  name: string,
  box: BoardBox,
  pts: readonly (readonly [number, number])[],
): EmbedBody {
  const ring: GeoJSON.Position[] = smoothRing(pts).map((p) => [...place(box)(p)]);
  return {
    id,
    name,
    outline: { type: 'Polygon', coordinates: [[...ring, ring[0] as GeoJSON.Position]] },
  };
}

// ── 2.1 Safety · Unsafe report (Mascoma Lake, the real outline) ─────────────────────────────

export const MASCOMA: EmbedBody = { id: 'mascoma', name: 'Mascoma Lake', outline: MASCOMA_POLYGON };

export const REPORT_POINT: ReportPointInput = {
  body: MASCOMA,
  // Off the town beach (the board's own point).
  report: { id: 'r1', at: [-72.1572, 43.6309], name: 'Town beach' },
  safety: true,
  caption: 'Report point · town beach',
};

// ── 2.2 Access reports · Dispute (Tomhannock Reservoir, Troy NY) ────────────────────────────

/** 336 × 300 at 46 px a kilometer. */
const TOMH: BoardBox = { minLng: -73.6298, maxLng: -73.5403, minLat: 42.8387, maxLat: 42.8973 };
const tomh = place(TOMH);

export const TOMHANNOCK = boardBody('tomhannock', 'Tomhannock Reservoir', TOMH, [
  [0.44, 0.06],
  [0.53, 0.08],
  [0.57, 0.17],
  [0.63, 0.26],
  [0.6, 0.36],
  [0.67, 0.44],
  [0.71, 0.53],
  [0.65, 0.63],
  [0.58, 0.72],
  [0.52, 0.77],
  [0.46, 0.755],
  [0.47, 0.66],
  [0.44, 0.57],
  [0.38, 0.49],
  [0.41, 0.39],
  [0.36, 0.29],
  [0.39, 0.16],
]);

export const ACCESS: AccessInput = {
  body: TOMHANNOCK,
  access: [{ id: 'dam-road', kind: 'putIn', at: tomh([0.49, 0.745]), name: 'Dam-road launch' }],
};

// ── 2.3 Requests · Admit (an unnamed pond near Groton VT, Ricker Pond west of it) ───────────

/** The board's full-width embed (788 × 318) at 62 px for 200 m. */
const GROTON: BoardBox = { minLng: -72.2724, maxLng: -72.2405, minLat: 44.2405, maxLat: 44.2497 };
const groton = place(GROTON);

export const UNNAMED_POND = boardBody('yq4k2', 'Unnamed pond', GROTON, [
  [0.56, 0.26],
  [0.64, 0.2],
  [0.73, 0.24],
  [0.78, 0.36],
  [0.76, 0.52],
  [0.79, 0.66],
  [0.72, 0.78],
  [0.62, 0.76],
  [0.57, 0.64],
  [0.53, 0.5],
  [0.54, 0.36],
]);

export const RICKER_POND = boardBody('ricker', 'Ricker Pond', GROTON, [
  [-0.04, 0.4],
  [0.05, 0.37],
  [0.12, 0.45],
  [0.13, 0.58],
  [0.1, 0.72],
  [0.02, 0.8],
  [-0.05, 0.7],
]);

const KATE_SKATE = [
  [0.585, 0.66],
  [0.57, 0.55],
  [0.575, 0.42],
  [0.6, 0.33],
  [0.655, 0.29],
  [0.7, 0.33],
  [0.68, 0.42],
  [0.63, 0.47],
  [0.66, 0.55],
  [0.72, 0.58],
  [0.74, 0.5],
  [0.73, 0.4],
] as const;

export const ADMIT: AdmitInput = {
  candidate: UNNAMED_POND,
  asks: [
    { id: 'kd', at: groton([0.585, 0.68]), name: 'Kate Donovan' },
    { id: 'lp', at: groton([0.6, 0.62]), name: 'Luc Pelletier' },
  ],
  tracks: [{ id: 'kd', path: KATE_SKATE.map(groton) }],
  nearest: RICKER_POND,
  legend: {
    candidate: 'Catalog outline · not ours yet',
    track: 'Kate Donovan’s skate',
    nearest: 'Ours',
  },
  candidateFact: 'Unnamed · 41 ac',
};

/** An admit no catalog feature matched (the list's "A pond off Ruddsboro Road"). */
export const ADMIT_NO_MATCH: AdmitInput = {
  candidate: null,
  asks: [{ id: 'jm', at: [-72.2386, 43.7322], name: 'Jamie Moreau' }],
  caption: 'Asked here · no catalog feature',
};

// ── 2.4 Places asked · Lookalike (Newfound Lake, the Narrows) ───────────────────────────────

/** 380 × 290 at 60 px for 0.4 mi. */
const NEWFOUND: BoardBox = { minLng: -71.7846, maxLng: -71.734, minLat: 43.6585, maxLat: 43.6864 };

export const NEWFOUND_LAKE = boardBody('newfound', 'Newfound Lake', NEWFOUND, [
  [0.18, 1.05],
  [0.2, 0.78],
  [0.34, 0.64],
  [0.42, 0.5],
  [0.43, 0.36],
  [0.38, 0.22],
  [0.4, 0.06],
  [0.52, -0.05],
  [0.66, -0.05],
  [0.62, 0.1],
  [0.56, 0.24],
  [0.58, 0.36],
  [0.6, 0.5],
  [0.7, 0.62],
  [0.86, 0.74],
  [0.92, 1.05],
]);

export const LOOKALIKE: LookalikeInput = {
  body: NEWFOUND_LAKE,
  asked: { id: 'narrows', at: [-71.7588, 43.6702], name: '“the Narrows”' },
  lookalikes: [{ id: 'osm-narrows', at: [-71.7571, 43.676], name: 'The Narrows · OpenStreetMap' }],
};

// ── 2.5 Drawn bodies · Merge (Caspian Lake, Greensboro VT) ──────────────────────────────────

/** The full-width embed (788 × 336) at 52 px for 500 m. */
const CASPIAN: BoardBox = { minLng: -72.3449, maxLng: -72.2491, minLat: 44.5884, maxLat: 44.6175 };
const caspian = place(CASPIAN);

export const CASPIAN_LAKE = boardBody('caspian', 'Caspian Lake', CASPIAN, [
  [0.4, 0.08],
  [0.5, 0.06],
  [0.58, 0.12],
  [0.62, 0.26],
  [0.6, 0.4],
  [0.63, 0.55],
  [0.62, 0.72],
  [0.56, 0.88],
  [0.47, 0.92],
  [0.41, 0.84],
  [0.42, 0.7],
  [0.38, 0.55],
  [0.4, 0.4],
  [0.37, 0.24],
]);

export const CASPIAN_DRAWING = boardBody('drawn-kd', 'Drawn by Kate Donovan', CASPIAN, [
  [0.47, 0.14],
  [0.56, 0.14],
  [0.62, 0.28],
  [0.64, 0.42],
  [0.66, 0.58],
  [0.63, 0.74],
  [0.55, 0.84],
  [0.5, 0.8],
  [0.5, 0.66],
  [0.48, 0.5],
  [0.47, 0.34],
]);

export const DRAWN: DrawnInput = {
  body: CASPIAN_LAKE,
  drawing: CASPIAN_DRAWING,
  track: {
    id: 'kd-11oct',
    path: (
      [
        [0.53, 0.82],
        [0.57, 0.74],
        [0.59, 0.6],
        [0.58, 0.46],
        [0.58, 0.32],
        [0.55, 0.2],
        [0.5, 0.17],
      ] as const
    ).map(caspian),
  },
  legend: {
    body: 'Caspian Lake · ours · 789 ac',
    drawing: 'Drawn 12 Oct · Kate Donovan',
    track: 'The recorded skate · 11 Oct',
  },
  drawingFact: '8 % on the shore',
  // Caspian Lake is ours, so the archive holds its passes (a story's still can't paint one).
  aerial: {
    key: 'frames/winter-2026-27/S2C_CASPIAN-visual.pmtiles',
    granuleId: 'S2C_CASPIAN',
    band: 'visual',
    capturedAt: '2026-10-08T15:40:00Z',
    season: 'winter-2026-27',
  },
};

// ── 2.6 Content flags · Access alert (Lake Morey, Fairlee VT) ───────────────────────────────

/** 300 × 305 at 40 px for 500 m. */
const MOREY: BoardBox = { minLng: -72.1885, maxLng: -72.1415, minLat: 43.9009, maxLat: 43.9352 };
const morey = place(MOREY);

export const LAKE_MOREY = boardBody('morey', 'Lake Morey', MOREY, [
  [0.42, 0.1],
  [0.52, 0.08],
  [0.6, 0.16],
  [0.62, 0.3],
  [0.6, 0.44],
  [0.64, 0.58],
  [0.66, 0.72],
  [0.6, 0.86],
  [0.5, 0.9],
  [0.44, 0.82],
  [0.45, 0.68],
  [0.4, 0.54],
  [0.42, 0.4],
  [0.38, 0.24],
]);

export const ALERT: AlertInput = {
  body: LAKE_MOREY,
  target: { id: 'fairlee', kind: 'putIn', at: morey([0.62, 0.84]), name: 'Fairlee town launch' },
  others: [{ id: 'bonnie-oaks', kind: 'putIn', at: morey([0.4, 0.2]), name: 'Bonnie Oaks' }],
};
