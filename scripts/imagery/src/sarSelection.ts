/**
 * Deciding which Sentinel-1 granules are worth booting a Machine for (N6e PR 2, §C1).
 *
 * The radar sibling of `granuleSelection`. Separate file rather than a second branch in that one,
 * because almost nothing is shared: S1 ids carry no MGRS tile, there is no cloud figure to gate on,
 * and "superseded" means something different. What *is* shared — that a drop is always counted and
 * named, never silent — is mirrored deliberately.
 *
 * ## ⚠ Sentinel-1 has one radar band, not several
 *
 * Worth stating because "all the radar bands" is the natural way to think about it and it is not how
 * the instrument works. Sentinel-1 is a **single C-band SAR** (5.405 GHz). What varies between
 * acquisitions is **polarisation** — which orientation the pulse is transmitted and received in — and
 * that is a property of one band, not a set of them. Copernicus flies no L-band or X-band radar, so
 * after this there is no further radar to add.
 *
 *     SV  single  VV            DV  dual  VV + VH      ← what we want
 *     SH  single  HH            DH  dual  HH + HV
 *
 * **VH is the one that matters.** Measured over Champlain across winter 2025-26 (see
 * `plans/PR2-HANDOFF-2.md` §4c), on lakes that actually freeze: **VH separates open water from
 * midwinter ice by ~2 dB and VV does not** (+1.88 / +2.28 dB against +0.79 / +0.63, replicated
 * independently on S1A and S1C). A single-pol `SV` acquisition carries no VH at all, so it cannot
 * answer the question the pilot exists to ask — which is why `DV` is the default and not merely a
 * preference.
 *
 * ## What this deliberately does NOT filter on, and why
 *
 * **Orbit direction.** Ascending and descending passes see the same lake at different incidence
 * angles, so their backscatter is not comparable and a timeline must not mix them. The instinct is to
 * pick one here — but that is the cloud-gate mistake in a different costume, and the founder already
 * settled the general form of it (2026-08-24): *"cut & store all imagery… then we can rerun whatever
 * we want without hitting them again."* Discarding half the passes at selection time is irreversible;
 * recording `sat:orbit_state` in the manifest and letting the consumer filter is not. Same for the
 * platform: S1A and S1C differ by ~1 dB uncalibrated, which is a read-time correction, not a reason
 * to throw a pass away.
 *
 * So this drops granules that are **unusable** (wrong product, no VH) and keeps everything that is
 * merely *different*. The counts below report the mix so an operator can see what they are getting.
 */

import type { GranuleCandidate } from './granuleSelection';

/**
 * A Sentinel-1 granule id decomposed.
 *
 * Ids read `S1A_IW_GRDH_1SDV_20260213T224345_20260213T224410_063207_07EF6A`:
 *
 *     S1A         platform
 *     IW          beam mode — Interferometric Wide, the land default
 *     GRDH        product: Ground Range Detected, High resolution
 *     1SDV        processing level 1, class S(tandard), polarisation DV
 *     2026…345    acquisition start
 *     2026…410    acquisition stop
 *     063207      absolute orbit number
 *     07EF6A      mission data-take id
 */
export interface SarGranuleKey {
  platform: string;
  mode: string;
  productType: string;
  polarisation: 'SH' | 'SV' | 'DH' | 'DV';
  startedAt: string;
  stoppedAt: string;
  absoluteOrbit: string;
  dataTake: string;
}

const SAR_GRANULE_ID =
  /^(S1[A-D])_(IW|EW|SM|WV|S[1-6])_(GRDH|GRDM|SLC|OCN)_1([SA])(SH|SV|DH|DV)_(\d{8}T\d{6})_(\d{8}T\d{6})_([0-9A-F]{6})_([0-9A-F]{6})$/;

/** Parse a Sentinel-1 granule id, or `null` if it is not one we recognise. */
export function parseSarGranuleId(id: string): SarGranuleKey | null {
  const match = SAR_GRANULE_ID.exec(id);
  if (!match) return null;
  return {
    platform: match[1] as string,
    mode: match[2] as string,
    productType: match[3] as string,
    polarisation: match[5] as SarGranuleKey['polarisation'],
    startedAt: match[6] as string,
    stoppedAt: match[7] as string,
    absoluteOrbit: match[8] as string,
    dataTake: match[9] as string,
  };
}

export interface SarSelectionOptions {
  /**
   * Polarisation configurations worth cutting. Defaults to `DV` — the only one carrying VH from a
   * V-transmit pass, and therefore the only one that can answer the pilot's question.
   */
  polarisations?: ReadonlySet<SarGranuleKey['polarisation']>;
  /** Beam modes worth cutting. Defaults to `IW`, which is what Sentinel-1 runs over land. */
  modes?: ReadonlySet<string>;
  /**
   * Product types worth cutting. Defaults to `GRDH`.
   *
   * `SLC` carries phase and is four times the size — the input to interferometry, which we are not
   * doing. `OCN` is a derived ocean product with no imagery in it at all.
   */
  productTypes?: ReadonlySet<string>;
}

export interface SarSelectionResult {
  selected: string[];
  rejected: {
    id: string;
    reason: 'unparseable' | 'polarisation' | 'mode' | 'product' | 'duplicate';
    detail?: string;
  }[];
  counts: {
    considered: number;
    selected: number;
    unparseable: number;
    polarisation: number;
    mode: number;
    product: number;
    duplicate: number;
  };
  /**
   * What the selection actually contains, so the operator sees the mix rather than assuming one.
   *
   * ⚠ **These are the axes a timeline must not blend.** A per-body series that mixes orbit directions
   * or platforms is reading an instrument difference as an ice change.
   */
  mix: {
    byPlatform: Record<string, number>;
    byOrbitDirection: Record<string, number>;
  };
}

const DEFAULT_POLARISATIONS = new Set<SarGranuleKey['polarisation']>(['DV']);
const DEFAULT_MODES = new Set(['IW']);
const DEFAULT_PRODUCTS = new Set(['GRDH']);

/**
 * Choose the Sentinel-1 granules to cut.
 *
 * ## Dedup keys on **platform + acquisition start**, and the reason is a trap
 *
 * The S2 path dedups on `tile + date`, keeping the highest processing version. Neither half of that
 * transfers. S1 has no tile, and — more dangerously — a single pass is delivered as **several
 * consecutive slices** along the orbit, which share a data-take id and differ only in their
 * timestamps. Two ids from 13 February 2026 illustrate it exactly:
 *
 *     S1A_IW_GRDH_1SDV_20260213T224345_20260213T224410_063207_07EF6A
 *     S1A_IW_GRDH_1SDV_20260213T224410_20260213T224435_063207_07EF6A
 *
 * Same platform, same orbit, same data-take, **different ground** — the second slice begins where the
 * first ends. Keying dedup on the data-take would collapse them and silently drop half a pass; keying
 * on the date would drop even more. A satellite is in exactly one place at one instant, so
 * `platform + startedAt` identifies an acquisition slice uniquely and cannot merge neighbours.
 *
 * That leaves reprocessings, which is what dedup is actually for: the same slice re-delivered under a
 * newer baseline. Earth Search's id omits the trailing product-unique suffix, so those arrive as
 * genuinely identical ids and this collapses them.
 */
export function selectSarGranules(
  candidates: readonly GranuleCandidate[],
  options: SarSelectionOptions = {},
): SarSelectionResult {
  const polarisations = options.polarisations ?? DEFAULT_POLARISATIONS;
  const modes = options.modes ?? DEFAULT_MODES;
  const productTypes = options.productTypes ?? DEFAULT_PRODUCTS;

  const rejected: SarSelectionResult['rejected'] = [];
  const kept = new Map<string, { key: SarGranuleKey; candidate: GranuleCandidate }>();

  for (const candidate of candidates) {
    const key = parseSarGranuleId(candidate.id);
    if (!key) {
      rejected.push({ id: candidate.id, reason: 'unparseable' });
      continue;
    }
    if (!modes.has(key.mode)) {
      rejected.push({ id: candidate.id, reason: 'mode', detail: key.mode });
      continue;
    }
    if (!productTypes.has(key.productType)) {
      rejected.push({ id: candidate.id, reason: 'product', detail: key.productType });
      continue;
    }
    if (!polarisations.has(key.polarisation)) {
      rejected.push({ id: candidate.id, reason: 'polarisation', detail: key.polarisation });
      continue;
    }

    const slot = `${key.platform}_${key.startedAt}`;
    if (kept.has(slot)) {
      rejected.push({ id: candidate.id, reason: 'duplicate', detail: slot });
      continue;
    }
    kept.set(slot, { key, candidate });
  }

  // Ordered by acquisition instant, then platform — so a fan-out's logs read chronologically and a
  // partial backfill is resumable by eye, the same property the S2 ordering was chosen for.
  const entries = [...kept.values()].sort((a, b) =>
    a.key.startedAt === b.key.startedAt
      ? a.key.platform.localeCompare(b.key.platform)
      : a.key.startedAt.localeCompare(b.key.startedAt),
  );

  const byPlatform: Record<string, number> = {};
  const byOrbitDirection: Record<string, number> = {};
  for (const { key, candidate } of entries) {
    byPlatform[key.platform] = (byPlatform[key.platform] ?? 0) + 1;
    // `unknown` rather than a guess: an absent orbit state is a gap in the metadata, and a timeline
    // that must not mix directions needs to know it cannot tell.
    const dir = candidate.orbitDirection ?? 'unknown';
    byOrbitDirection[dir] = (byOrbitDirection[dir] ?? 0) + 1;
  }

  const count = (reason: SarSelectionResult['rejected'][number]['reason']) =>
    rejected.filter((r) => r.reason === reason).length;

  return {
    selected: entries.map((e) => e.candidate.id),
    rejected,
    counts: {
      considered: candidates.length,
      selected: entries.length,
      unparseable: count('unparseable'),
      polarisation: count('polarisation'),
      mode: count('mode'),
      product: count('product'),
      duplicate: count('duplicate'),
    },
    mix: { byPlatform, byOrbitDirection },
  };
}
