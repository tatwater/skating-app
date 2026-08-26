/**
 * What the freeze-up archive publishes, and which season an app should be showing (N6e §C2, D149).
 *
 * ## Why the producer's output type lives in core
 *
 * The archive is built by `@skating/imagery` — the ETL that drives the Fly granule cutter — and read
 * by both apps. If the shape lived with the producer, a client wanting to type the JSON it just
 * fetched would have to depend on a package that exists to shell out to GDAL and `fly machine run`.
 *
 * So the **producer declares its output type here**, in the package both sides already share. The same
 * reasoning `webMercator` gives for living in core rather than the web app: one definition, because a
 * second one is a second chance to disagree.
 *
 * This module is deliberately *only* the published shape. `FrameManifest` — what one cut Machine
 * writes beside its `.pmtiles` — stays in the ETL, because nothing outside the producer ever sees a
 * manifest. What a client sees is the index built from them.
 */

import type { MultiPolygon, Polygon } from 'geojson';

import { type Season, seasonOf } from './season';

/**
 * The archive's season label — `winter-2025-26`.
 *
 * **One definition, because a second one is a second chance to disagree**, and this had already
 * started: `bakeMasks` built the string inline to name a mask artifact, the ingest watcher built it
 * again to key a row, and the two had to agree exactly or a cut would be filed against a prefix
 * nothing reads. `cut-granule.sh` holds a third copy in shell that cannot import this — see the note
 * there — which is precisely why the TypeScript side should not hold a fourth.
 *
 * The `-YY` half is the *following* year's last two digits, zero-padded, so the label sorts correctly
 * as a string (`latestSeasonWithFrames` depends on that) and reads the way a skater says it.
 */
export function archiveSeasonLabel(season: Season): string {
  return `winter-${season}-${String((season + 1) % 100).padStart(2, '0')}`;
}

/**
 * The archive season an instant falls in — D63's July boundary, via `seasonOf`.
 *
 * Deriving it here rather than re-implementing the month test is the point: a January frame belongs to
 * the winter that began the previous July, and getting that backwards files a whole backfill under the
 * wrong year.
 */
export function archiveSeasonAt(ms: number): string {
  return archiveSeasonLabel(seasonOf(ms));
}

/**
 * One frame in a season's scrubber.
 *
 * `capturedAt` and `cloudCoverPct` are **content, not metadata** (D84, §C4): a timeline invites
 * inference far harder than a still image does, so every frame carries its own date and its own cloud
 * caveat, and they travel with the frame rather than sitting as furniture around the control.
 */
export interface IndexedFrame {
  granuleId: string;
  /** ISO instant the satellite took this picture. */
  capturedAt: string;
  /**
   * Granule-wide cloud fraction, or `null` when the source did not report one — never a guess.
   *
   * ⚠ **Optical only, and `null` means two different things depending on the mission.** On a
   * `visual` frame it means the catalogue did not report a figure. On a **radar** frame it means the
   * question does not apply — radar sees straight through cloud, so `null` there is not a gap in the
   * metadata and must not be shown as a caveat or treated as an unknown worth flagging.
   */
  cloudCoverPct: number | null;
  /** How many corpus bodies this frame actually contains. */
  bodies: number;
  /**
   * Which band this frame renders — **and, by implication, which mission it came from.**
   *
   * ⚠ **One index holds both missions**, so `band` is the discriminator and a consumer must never
   * assume. Today: `visual` is Sentinel-2's true-colour composite; `vh` is Sentinel-1's calibrated
   * radar brightness. A timeline built without filtering on this interleaves photographs and radar
   * greyscale on one scrubber, which is not a rendering glitch but two different measurements
   * presented as one series.
   *
   * The per-body statistics split the same way, and a reader wants the right half: optical frames
   * carry `clearPct`/`snowIcePct`/`waterPct`, radar frames carry `vvDb`/`vhDb`. Only `coveragePct`
   * and `pixels` are common to both. See `FrameManifest` in `@skating/imagery`.
   *
   * ⚠ **Radar readings do not pool across satellites or flight directions** — measured 2026-08-25,
   * the surviving post-calibration offset is up to 1.5 dB against a ~2 dB ice signal. Anything
   * building a `vh` series must hold `platform` and `orbitDirection` constant. See
   * `docs/reading-ice-from-orbit.md`, *Calibration helps a great deal and is not enough*.
   */
  band: string;
  /**
   * Key within the archive bucket.
   *
   * A key rather than a URL, so a client composes its own address from whatever base it was
   * configured with — the same split the basemap and bathymetry archives already use, and what lets
   * dev and prod point at different buckets without the artifact knowing.
   */
  key: string;
  /**
   * Where this frame has pixels — the satellite's own acquisition polygon, from the STAC item.
   *
   * **Without it a scrubber cannot tell "this lake was not photographed that day" from "this lake was
   * photographed and looked like nothing",** and the timeline degrades to showing every frame and
   * hoping. A Sentinel pass covers one ~110 km tile; a season's frames are scattered across ~54 of
   * them, so most frames are irrelevant to any given lake and saying so is the whole job.
   *
   * The **granule** footprint rather than the cut's raster extent, deliberately. The raster is sized
   * to the bounding box of every mask the granule touches, which can reach past the granule's own
   * edge — those pixels come back transparent. The acquisition polygon is the honest bound on where
   * imagery exists at all, and it is a real quadrilateral rather than a bbox, so it does not claim
   * the corners of a rotated swath.
   *
   * Optional because frames cut before 2026-08-24 predate the field. A reader with no footprint
   * should treat coverage as unknown and say so, never as universal.
   */
  footprint?: Polygon | MultiPolygon;
}

/** A season's frames, ascending by capture time — the axis a scrubber moves along. */
export interface SeasonIndex {
  season: string;
  frames: IndexedFrame[];
  /** The span the scrubber's ends snap to. `null` when the season has no frames. */
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
}

/** What `index/latest.json` holds — the pointer that *is* D149's turnover. */
export interface ArchivePointer {
  season: string;
}

/**
 * What one pass measured about one lake.
 *
 * ## Why this lives in core, when the manifest around it does not
 *
 * The per-granule manifest is mostly producer bookkeeping — stage timings, VM size, the mask season it
 * was clipped against — and none of that is a client's business. **But the `bodies` array is**, because
 * it is the only place per-lake coverage and cloud exist, and a scrubber cannot be built without them:
 * the season index deliberately carries a body *count* and not a body *list*, since ~4,500 frames a
 * season × up to ~2,700 bodies per granule is millions of entries in one file every client would
 * download to draw one lake.
 *
 * So the shape a consumer reads is declared here and the envelope stays with the producer.
 *
 * ## ⚠ Optical and radar fill in different halves of this
 *
 * `zonal-clear.py` writes the SCL statistics; `sar-zonal.py` writes `vvDb`/`vhDb` and **neither**
 * `clearPct` nor `waterPct` nor `snowIcePct` — there is no scene classification on a radar pass and no
 * cloud to be clear of. Only `waterBodyId`, `coveragePct` and `pixels` are common to both, which is
 * why every mission-specific field is optional and has to be.
 */
export interface FrameBodyStats {
  waterBodyId: string;
  /**
   * Unobscured fraction of the pixels this granule actually saw. `null` = we could not see it.
   *
   * **This is the per-lake cloud figure, and it is the one to gate a scrubber on** — `cloudCoverPct`
   * on the frame is granule-wide, so a pass 70% clouded over the White Mountains says nothing about
   * whether Champlain was visible.
   *
   * Optical only; absent on radar, where there is nothing to be obscured by.
   */
  clearPct?: number | null;
  /**
   * How much of the body this granule reached, 0–1 — the weight `clearPct` carries.
   *
   * **This is what makes the split-body seam drawable.** A body bisected by a granule edge appears in
   * two frames and neither is wrong; the ratio says which side came from which pass. `null` when the
   * granule shipped without SCL, because coverage is then unmeasured rather than zero.
   */
  coveragePct: number | null;
  /**
   * Fraction of the pixels this granule saw that SCL called snow/ice (class 11).
   *
   * ⚠ **It is `snowIcePct` because it measures SNOW.** SCL's class 11 finds *bright* frozen surfaces,
   * and black ice is transparent — the light returns off the dark lake bottom, so the classifier calls
   * it water. Measured: Mascoma Lake, 22 December 2025, 98% clear, **2.3% "ice", 82.5% water** — and
   * the founder skated its full length the next morning. So a high number means *snow-covered ice*, a
   * low number means *water **or** the best skating ice of the year*, and anything reading this as
   * "is it frozen" will be wrong in December.
   *
   * ⚠ **A measurement, not a verdict** (D147, D150). Read it through {@link snowIceFractionOf}, which
   * handles the pre-rename key. See `docs/reading-ice-from-orbit.md`.
   */
  snowIcePct?: number | null;
  /**
   * @deprecated The pre-2026-08-25 name for `snowIcePct`. Identical measurement, misleading label.
   *
   * Exactly one of the two is present, decided by when the frame was cut — the 4,381 optical frames of
   * winter 2025-26 carry this one. Use {@link snowIceFractionOf} rather than reaching for either.
   */
  icePct?: number | null;
  /** Fraction SCL called water, over the same denominator as `snowIcePct`. Optical only. */
  waterPct?: number | null;
  /**
   * Mean `sigma0` over the body in decibels, per polarisation — **radar only**.
   *
   * `VH` is the informative channel: it separates open water from midwinter ice by ~2 dB where `VV`
   * manages 0.6–0.8. `null` when the pass reached the body but no pixel was usable.
   *
   * ⚠ **Comparable only within one platform and one orbit direction, and this is measured rather than
   * assumed.** Across all 503 radar passes of winter 2025-26, calibration leaves an S1A−S1C offset of
   * −0.52 dB VH ascending and +1.53 dB VH descending. Pooled across directions it reads −0.03 dB,
   * which is two opposite biases cancelling — **so a consumer that drops those filters sees agreement
   * that is not there**, at a scale comparable to the signal.
   */
  vvDb?: number | null;
  vhDb?: number | null;
  /** How many raster pixels backed these numbers. A floor on this is how you avoid reading noise. */
  pixels: number;

  // ── Added 2026-08-25, before the nine-season backfill ──────────────────────────────────────────
  //
  // Everything below is absent on the 4,381 frames cut before that date. All of it exists because
  // deriving it later would mean re-reading all 40,365 granules of a nine-season run — the cheap
  // moment is while the raster is open, and it does not come again.

  /**
   * The same pixels with the shoreline eroded off — one ring on optical, two on radar.
   *
   * ⚠ **The count matters more than the cleaner percentage.** N6g Lane 2 eliminates bodies on "never
   * observed frozen", and a body too small to classify reads exactly like a body that never froze. A
   * 1-acre pond keeps under ten voting pixels; measured on a synthetic 3×3-pixel pond, exactly one.
   */
  interiorPixels?: number;
  /** The eroded body's size irrespective of this pass — what an area floor is set against. */
  interiorTotalPixels?: number;
  interiorSnowIcePct?: number | null;
  interiorWaterPct?: number | null;

  /**
   * All twelve SCL classes over the body's pixels, indexed by class — optical only.
   *
   * The percentages above are one *reading* of the classification; this is the classification. Every
   * future reading is derivable from it: `valid = total − hist[0] − hist[1]`, a stricter cloud rule,
   * whether cast shadow should have counted, how much confusion is cirrus rather than opaque cloud.
   */
  classHist?: number[] | null;
  interiorClassHist?: number[] | null;

  /**
   * Normalised Difference Snow Index over the eroded body — optical only.
   *
   * The independent second opinion where SCL is weakest: snow and cloud are both bright in the
   * visible and only snow is dark in the shortwave infrared. ⚠ **It will not find black ice** — it is
   * a snow index built on the same brightness that misleads class 11.
   */
  ndsiMean?: number | null;
  ndsiPixels?: number;
  /** 40 bins over −1…1. Fixed edges, so two lakes and two seasons are comparable. */
  ndsiHist?: number[] | null;

  /** Mean `sigma0` over the eroded body, per polarisation — radar only. */
  interiorVvDb?: number | null;
  interiorVhDb?: number | null;
  /**
   * Per-polarisation `sigma0` distribution over the eroded body — 45 bins of 1 dB from −35 to +10.
   *
   * **A mean cannot answer the question the archive was built for.** It cannot distinguish a
   * uniformly medium-rough lake from one half glassy and half ridged, which is the entire premise of
   * N6g Lane 1: *"40% of this lake sat below −22 dB"* is a claim about smoothness that *"this lake
   * averaged −20 dB"* cannot make. Measured on a test fixture, the mean read −15.5 dB — a value that
   * occurred nowhere on the lake.
   */
  sigma0Hist?: Record<string, number[]> | null;
  /**
   * Fraction of pixels whose power went non-positive once thermal noise was subtracted, per pol.
   *
   * ⚠ **A high figure is not a smooth lake — it is a lake the instrument cannot measure.** Anything
   * calling a body specular has to read this first. Measured on a real pass: median 0.000, p90 0.035,
   * max 0.297.
   */
  belowNoiseFloorPct?: Record<string, number | null> | null;

  /**
   * The viewing geometry this body was measured at — radar only.
   *
   * ⚠ **`sigma0` genuinely varies with incidence angle**, and ice and water have *different* angular
   * responses, so without this a consumer cannot separate an instrument difference from an ice
   * change. Measured across one region, local incidence spanned 30.9°–44.8° while the scene mean sat
   * at 38.6° — and `1/tan` moves 60% across that span, so the scene figure was never a stand-in.
   *
   * This is the field N6e open question 7 names as missing when it asks why S1C disagrees with itself.
   */
  incidenceDeg?: number | null;
  /** The local terrain height the product geocoded this body at — never a scene average. */
  geocodeReferenceHeightM?: number | null;
  /** The whole-pixel correction applied, in GROUND metres, so a frame can be audited or undone. */
  geocodeShiftM?: { east: number; north: number } | null;
}

/**
 * The client-readable half of a per-granule manifest.
 *
 * Structural rather than exhaustive: the producer's `FrameManifest` has more, and a consumer that
 * fetches the JSON gets all of it — this names only the part a client has business reading, so the
 * producer stays free to change its bookkeeping without a client noticing.
 */
export interface FrameStats {
  granuleId: string;
  capturedAt: string;
  /** `s1` for radar, `s2` for optical. The cheapest way to know which half of the stats to expect. */
  mission?: string;
  /** ⚠ Radar only, and load-bearing for comparability — see {@link FrameBodyStats.vhDb}. */
  platform?: string;
  orbitDirection?: string;
  /**
   * The repeat track, and a **finer** comparability key than `orbitDirection`.
   *
   * Direction separates east-looking from west-looking. This separates the individual tracks *within*
   * a direction, which still view a lake at different incidence angles — so holding only direction
   * constant holds most of the geometry constant, not all of it. Worth reaching for if a series built
   * per-direction still looks noisier than it should.
   */
  relativeOrbit?: number | null;
  bodies?: FrameBodyStats[];
}

/**
 * Copernicus' required credit, with the years the frames were actually taken in.
 *
 * ## Why a required credit lives beside the archive rather than in a credits module
 *
 * ⚠ **Attribution here is source-derived, not hand-composed.** MapLibre's `AttributionControl` unions
 * the `attribution` of every *active source*, so a credit appears the moment its layer mounts and
 * disappears when it unmounts, with nothing to remember — which is what `mapCanvas` chose it for, and
 * why the basemap and the aerial reveal declare theirs on their own sources. A separate list of
 * credits somewhere else is the version that goes stale the first time someone adds a layer.
 *
 * So this is not a credits registry. It is the string the freeze-up *source* declares, next to the
 * keys and the season label it is built from.
 *
 * ESA's terms ask for *"Copernicus Sentinel data [year]"*. A winter spans two calendar years and the
 * archive is keyed by season, so both are named rather than picking one and being wrong for half the
 * frames. An unparseable season degrades to the bare required form: a wrong year is worse than none,
 * and neither is a reason to omit a credit a licence compels.
 *
 * ⚠ Unlike NAIP's — public-domain federal work, and courtesy only — **this one is required.**
 */
/**
 * `winter-2025-26` → `winter 2025–26`, the season as a person says it.
 *
 * Shared rather than re-derived per platform because it is now read against
 * {@link formatAerialSeason} in the same slot of the same heading — two spellings of a season would
 * make the panel look like it was describing two different kinds of thing, which is the opposite of
 * what putting them in one slot is for. An unparseable key degrades to itself: a raw `winter-2025-26`
 * on screen is legible and obviously ours, where a guess would not be.
 */
export function formatSeasonLabel(season: string): string {
  const match = /^winter-(\d{4})-(\d{2})$/.exec(season);
  return match ? `winter ${match[1]}–${match[2]}` : season;
}

export function copernicusCredit(season: string): string {
  const match = /^winter-(\d{4})-(\d{2})$/.exec(season);
  if (!match) return 'Copernicus Sentinel data';
  const start = Number(match[1]);
  return `Copernicus Sentinel data ${start}–${start + 1}`;
}

/**
 * Which bands a season actually published, in a stable order.
 *
 * **What a band selector should be built from**, rather than a hardcoded list. The archive's bands
 * have changed twice already — `scl` was statistics-only until 2026-08-25, and `vh` did not exist
 * until Sentinel-1 was wired — and frames cut under an older policy stay in the bucket. A control
 * offering a band the season has no frames for is a tab that leads to an empty scrubber.
 *
 * `visual` sorts first where present, because it is the one a skater came for; the rest follow
 * alphabetically so the order does not depend on which granule happened to be indexed first.
 */
export function bandsIn(index: SeasonIndex): string[] {
  const bands = [...new Set(index.frames.map((f) => f.band))].sort();
  return bands.includes('visual') ? ['visual', ...bands.filter((b) => b !== 'visual')] : bands;
}

/**
 * The pointer object, and D149's turnover as a path.
 *
 * A fixed key rather than a season-derived one, because the whole point is that a client does not
 * know which season it should be showing until it reads this.
 */
export const ARCHIVE_POINTER_KEY = 'index/latest.json';

/** Where a season's table of contents sits. */
export function seasonIndexKeyFor(season: string): string {
  return `index/${season}.json`;
}

/**
 * Compose an address from the base a deployment was configured with and a key from the archive.
 *
 * **A key rather than a URL is what the artifacts carry**, so dev and prod can point at different
 * buckets without anything in the archive knowing which one it landed in — the same split the basemap
 * and bathymetry archives already use.
 *
 * Tolerates a trailing slash on the base, because half the ways of setting an environment variable
 * add one and a doubled slash is a 404 on most object stores.
 */
export function archiveUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

/**
 * Where a frame's manifest sits in the bucket.
 *
 * ⚠ **Keyed on the granule, not the frame**, and the difference bites: one granule now publishes
 * several frames (`-visual.pmtiles`, `-scl.pmtiles`) that all share a single `<granuleId>.json`.
 * Deriving this by string-replacing a frame's `key` would produce `…-visual.json`, which does not
 * exist — and the 404 would look like a missing manifest rather than a malformed path.
 */
export function manifestKeyFor(season: string, granuleId: string): string {
  return `frames/${season}/${granuleId}.json`;
}

/**
 * The snow/ice fraction, whichever key this frame happens to carry.
 *
 * **The rename is a contract change mid-archive**, so every reader needs this fallback until the
 * optical season is re-cut. One function rather than `?? ` at each call site: the moment a consumer
 * forgets, it silently reads `undefined` on 4,381 frames and reports no snow across an entire winter.
 */
export function snowIceFractionOf(stats: FrameBodyStats): number | null {
  return stats.snowIcePct ?? stats.icePct ?? null;
}

/** One lake's row in a frame's statistics, or `undefined` if the pass did not reach it. */
export function bodyStatsIn(
  frame: Pick<FrameStats, 'bodies'>,
  waterBodyId: string,
): FrameBodyStats | undefined {
  return frame.bodies?.find((b) => b.waterBodyId === waterBodyId);
}

/**
 * Which season the app should be showing — D149's turnover, as one function.
 *
 * > **D149 — the archive turns over on the first frame of the new season, never on a date.**
 *
 * **The most recent season that has frames.** Not the current calendar season, and not the newest
 * directory: ingest starts *looking* in September on the summit trigger (§C3), so an empty
 * `winter-2027-28` exists for weeks before its first frame lands. Turning over on the directory would
 * take away a scrubber that has been serving last winter perfectly well since April and replace it
 * with nothing.
 *
 * Seasons sort correctly as strings because the label is `winter-YYYY-YY`.
 *
 * Lives here beside the type it governs rather than with the producer that calls it, so a client that
 * ever lists seasons for itself applies the same rule instead of reinventing a near-miss of it.
 */
export function latestSeasonWithFrames(indexes: readonly SeasonIndex[]): string | null {
  return (
    indexes
      .filter((index) => index.frames.length > 0)
      .map((index) => index.season)
      .sort()
      .at(-1) ?? null
  );
}
