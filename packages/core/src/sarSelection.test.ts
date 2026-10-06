import { describe, expect, it } from 'vitest';

import type { GranuleCandidate } from './granuleSelection';
import { parseSarGranuleId, selectSarGranules } from './sarSelection';

/** Real ids, taken from Earth Search over Champlain in winter 2025-26. */
const DV_SLICE_A = 'S1A_IW_GRDH_1SDV_20260213T224345_20260213T224410_063207_07EF6A';
const DV_SLICE_B = 'S1A_IW_GRDH_1SDV_20260213T224410_20260213T224435_063207_07EF6A';
const DV_S1C = 'S1C_IW_GRDH_1SDV_20260219T224255_20260219T224324_006431_00CF29';
const DH_S1A = 'S1A_IW_GRDH_1SDH_20260218T225212_20260218T225241_063280_07F22A';

const item = (id: string, extra: Partial<GranuleCandidate> = {}): GranuleCandidate => ({
  id,
  datetime: '2026-02-13T22:43:57Z',
  ...extra,
});

describe('parseSarGranuleId', () => {
  it('decomposes a real dual-pol IW GRD id', () => {
    expect(parseSarGranuleId(DV_SLICE_A)).toEqual({
      platform: 'S1A',
      mode: 'IW',
      productType: 'GRDH',
      polarisation: 'DV',
      startedAt: '20260213T224345',
      stoppedAt: '20260213T224410',
      absoluteOrbit: '063207',
      dataTake: '07EF6A',
    });
  });

  it('reads the polarisation out of the 1SDV field', () => {
    expect(parseSarGranuleId(DH_S1A)?.polarisation).toBe('DH');
    expect(parseSarGranuleId(DV_S1C)?.polarisation).toBe('DV');
  });

  it('returns null for a Sentinel-2 id rather than half-parsing it', () => {
    expect(parseSarGranuleId('S2C_18TXP_20260215_0_L2A')).toBeNull();
  });

  it('returns null for junk', () => {
    expect(parseSarGranuleId('')).toBeNull();
    expect(parseSarGranuleId('S1A_IW_GRDH')).toBeNull();
  });
});

describe('selectSarGranules', () => {
  it('⚠ keeps consecutive slices of one pass — they are different ground', () => {
    // Same platform, same orbit, same data-take; only the timestamps differ. Deduping on the
    // data-take (the obvious key) would silently drop half of every pass.
    const result = selectSarGranules([item(DV_SLICE_A), item(DV_SLICE_B)]);
    expect(result.selected).toEqual([DV_SLICE_A, DV_SLICE_B]);
    expect(result.counts.duplicate).toBe(0);
  });

  it('collapses a genuinely repeated id as a duplicate', () => {
    const result = selectSarGranules([item(DV_SLICE_A), item(DV_SLICE_A)]);
    expect(result.selected).toEqual([DV_SLICE_A]);
    expect(result.counts.duplicate).toBe(1);
    expect(result.rejected[0]).toMatchObject({ reason: 'duplicate' });
  });

  it('drops HH/HV, because a V-transmit VH series cannot use it', () => {
    const result = selectSarGranules([item(DV_SLICE_A), item(DH_S1A)]);
    expect(result.selected).toEqual([DV_SLICE_A]);
    expect(result.rejected).toEqual([{ id: DH_S1A, reason: 'polarisation', detail: 'DH' }]);
  });

  it('drops SLC and non-IW products by name, never silently', () => {
    const slc = 'S1A_IW_SLC__1SDV_20260213T224345_20260213T224410_063207_07EF6A';
    const wave = 'S1A_WV_GRDH_1SDV_20260213T224345_20260213T224410_063207_07EF6A';
    const result = selectSarGranules([item(slc), item(wave), item(DV_SLICE_A)]);
    expect(result.selected).toEqual([DV_SLICE_A]);
    // `SLC__` has two trailing underscores in the real id grammar, so it does not match the product
    // alternation and lands under `unparseable` — still counted, still named.
    expect(result.counts.selected).toBe(1);
    expect(result.counts.unparseable + result.counts.product + result.counts.mode).toBe(2);
  });

  it('⚠ does NOT filter on orbit direction — it reports the mix instead', () => {
    // Discarding half the passes at selection time is irreversible; recording the direction and
    // filtering at read time is not. Same call the founder made for cloud.
    const result = selectSarGranules([
      item(DV_SLICE_A, { orbitDirection: 'ascending' }),
      item(DV_S1C, { orbitDirection: 'descending' }),
    ]);
    expect(result.selected).toHaveLength(2);
    expect(result.mix.byOrbitDirection).toEqual({ ascending: 1, descending: 1 });
  });

  it('reports an absent orbit direction as unknown rather than guessing one', () => {
    const result = selectSarGranules([item(DV_SLICE_A)]);
    expect(result.mix.byOrbitDirection).toEqual({ unknown: 1 });
  });

  it('reports the platform mix, which a timeline must not blend uncalibrated', () => {
    const result = selectSarGranules([item(DV_SLICE_A), item(DV_S1C)]);
    expect(result.mix.byPlatform).toEqual({ S1A: 1, S1C: 1 });
  });

  it('orders by acquisition instant so a partial backfill is resumable by eye', () => {
    const result = selectSarGranules([item(DV_S1C), item(DV_SLICE_B), item(DV_SLICE_A)]);
    expect(result.selected).toEqual([DV_SLICE_A, DV_SLICE_B, DV_S1C]);
  });

  it('counts every drop, so the totals reconcile against what went in', () => {
    const result = selectSarGranules([
      item(DV_SLICE_A),
      item(DH_S1A),
      item('S2C_18TXP_20260215_0_L2A'),
    ]);
    const { considered, selected, unparseable, polarisation, mode, product, duplicate } =
      result.counts;
    expect(considered).toBe(3);
    expect(selected + unparseable + polarisation + mode + product + duplicate).toBe(considered);
  });

  it('widening the polarisation option keeps HH/HV, for an operator who wants everything', () => {
    const result = selectSarGranules([item(DV_SLICE_A), item(DH_S1A)], {
      polarisations: new Set(['DV', 'DH'] as const),
    });
    expect(result.selected).toHaveLength(2);
  });
});
