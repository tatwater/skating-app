/**
 * USGS **3DEP** elevation, via `epqs.nationalmap.gov` — the pure half (D101/D104, N7-2).
 *
 * ## Why this replaces the endpoint that was already working
 *
 * D101, approved 2026-08-03: *"the first question about a metered pass is not 'how do we pace it'
 * but 'why are we paying for this at all'."* The Open-Meteo elevation pass counts each **coordinate**
 * against a free tier the product's own weather crons are also spending, and it stalled at
 * **5,975 bodies, page 86 of ~248**. Elevation is a static property of a fixed point; nothing about
 * it needed a forecast API.
 *
 * **And it is a data upgrade, not merely a cheaper one.** `@skating/core`'s `elevation.ts` records
 * GLO-90 reading Shelburne Pond **20 m high** — the expected behaviour of a 90 m radar *surface*
 * model over water, where small ponds are never flattened to their waterline. EPQS serves 3DEP,
 * which is **1 m LiDAR** wherever the region has been flown. Measured at build time: every one of
 * the 45 bodies in the tidal probe came back `resolution: 1`, and Paugus Bay and Melvin Bay both
 * returned **153.1 m** — Winnipesaukee's published surface, to the decimetre, from two independent
 * points on the same lake.
 *
 * ## What it costs, measured rather than assumed
 *
 * D104 asked for a throughput test before committing. One request is one coordinate — there is no
 * batch form — and the measured latency is **~4 s**, which is slow enough that concurrency is the
 * whole story:
 *
 * | | |
 * | --- | --- |
 * | median latency | ~4,000 ms |
 * | throughput at concurrency 8 | **1.74 /s** |
 * | a 25,052-body pass | **~4.0 h** |
 * | key / documented cap | none of either |
 *
 * Four hours is a *once* cost, which is the entire argument for the archive beside this file: after
 * it, changing a threshold or deriving a new statistic is a local read. That is the lesson
 * `HANDOFF-wind-climate-archive.md` was written to stop us re-learning at 7.7 hours a time.
 */

import { isPlausibleElevationM } from '@skating/core';

/** The point-query service. No key, no account, and no documented daily cap (checked 2026-08-08). */
export const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';

/**
 * Decimal places kept in an archive key — **five, which is ~1.1 m at our latitude.**
 *
 * The archive is keyed on the coordinate rather than on a body id, and that is what makes it
 * survive a corpus rebuild: a lake whose polygon did not change has the same interior point next
 * campaign, so the entry is reused and no request is spent. Keying on `waterBodyId` would throw the
 * whole archive away every time the merge re-mints ids.
 *
 * Five places is finer than 3DEP's own 1 m posting, so rounding can never merge two points the DEM
 * would have distinguished; it exists to stop float formatting (`44.5` vs `44.500000000000004`)
 * producing two keys for one place.
 */
export const COORDINATE_KEY_PLACES = 5;

/** The archive key for a point — see `COORDINATE_KEY_PLACES`. */
export function coordinateKey(lat: number, lng: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`coordinateKey needs finite numbers, got ${lat},${lng}`);
  }
  return `${lat.toFixed(COORDINATE_KEY_PLACES)},${lng.toFixed(COORDINATE_KEY_PLACES)}`;
}

/** The request URL for one point. `includeDate` is what carries the raster's acquisition date. */
export function epqsUrl(lat: number, lng: number): string {
  const params = new URLSearchParams({
    x: String(lng),
    y: String(lat),
    units: 'Meters',
    wkid: '4326',
    includeDate: 'true',
  });
  return `${EPQS_URL}?${params.toString()}`;
}

/** One 3DEP reading, as the archive stores it. */
export interface EpqsReading {
  /** Metres above the vertical datum, already checked against the regional plausibility window. */
  elevationM: number;
  /** The source raster's ground sample distance in **metres** — see `resolutionMetres`. */
  resolutionM?: number | undefined;
  /** 3DEP's own raster id, so a lake stamped from a coarse DEM can be found and re-stamped later. */
  rasterId?: number | undefined;
  /** When that raster was flown, as 3DEP reports it. Free with `includeDate=true`. */
  acquisitionDate?: string | undefined;
}

/** Why a point produced no reading. Counted apart because they mean different things. */
export type EpqsRefusal =
  /** The response was not the shape EPQS documents — a proxy error page, most likely. */
  | 'unparseable'
  /** EPQS answered, with its no-data sentinel or a value outside the regional window. */
  | 'implausible';

export type EpqsOutcome =
  | { readonly ok: true; readonly reading: EpqsReading }
  | { readonly ok: false; readonly reason: EpqsRefusal; readonly raw: string };

/**
 * 3DEP's `resolution`, in metres — **and it is not always in metres.**
 *
 * The service echoes the raster's native cell size, and for some tiles that is expressed in the
 * raster's own units, which are **degrees**. Measured on the tidal probe: 44 of 45 points returned
 * `1`, and `Frost Cove` returned `0.00003086419871794868` — which is not a 31-micrometre DEM, it is
 * 3.4 m expressed as a fraction of a degree.
 *
 * Left as a number and converted here rather than stored raw, because the field's whole purpose
 * (D104) is that *"a lake stamped from a 30 m raster can be re-stamped from 1 m later"* — a
 * comparison that silently breaks the day two rows carry two different units.
 *
 * The cut is at 0.01: no real DEM has a centimetre posting, and no degree-expressed resolution
 * reaches a hundredth of a degree (1.1 km) for a product mapped at metre scale.
 */
export function resolutionMetres(raw: unknown, lat: number): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  if (value >= 0.01) return value;
  // Degrees. One degree of latitude is ~111,132 m; longitude shrinks with the cosine, and a cell is
  // square in degrees rather than in metres, so the latitude figure is the honest one to quote.
  const metresPerDegree = 111_132 * Math.cos((lat * Math.PI) / 180);
  return value * metresPerDegree;
}

/**
 * Read one EPQS response body into a reading, or say why not.
 *
 * `value` arrives as a **string** for a real reading (`"171.023330688"`) and EPQS uses
 * `-1000000` for no data, which `isPlausibleElevationM` already refuses along with anything else
 * outside the regional window — the same backstop the Open-Meteo lane applied, kept deliberately,
 * because a wrong number here is worse than no number: it is rendered as a fact.
 */
export function parseEpqsResponse(body: unknown, lat: number): EpqsOutcome {
  const raw = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)?.slice(0, 200);
  if (body === null || typeof body !== 'object') {
    return { ok: false, reason: 'unparseable', raw: raw ?? '' };
  }
  const json = body as Record<string, unknown>;
  if (!('value' in json)) return { ok: false, reason: 'unparseable', raw: raw ?? '' };
  const value = typeof json.value === 'string' ? Number(json.value) : json.value;
  if (!isPlausibleElevationM(value)) {
    return { ok: false, reason: 'implausible', raw: String(json.value) };
  }
  const attributes = (json.attributes ?? {}) as Record<string, unknown>;
  const acquired = attributes.AcquisitionDate;
  const rasterId = typeof json.rasterId === 'number' ? json.rasterId : undefined;
  return {
    ok: true,
    reading: {
      elevationM: value,
      resolutionM: resolutionMetres(json.resolution, lat),
      rasterId,
      acquisitionDate: typeof acquired === 'string' && acquired.length > 0 ? acquired : undefined,
    },
  };
}
