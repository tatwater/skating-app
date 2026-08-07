/**
 * The gazetteer's constants and header rules (N7 audit).
 *
 * These were untestable while they lived in `gnisArchive.ts`, because importing that module runs a
 * five-state download. That is the whole reason `gnisSource.ts` exists, and this file is the proof
 * that it worked: none of the assertions below touch the network.
 */

import { describe, expect, it } from 'vitest';
import {
  GNIS_COLUMNS,
  GNIS_STATE_CODES,
  GNIS_WATER_CLASSES,
  gnisColumnIndexes,
  gnisTextPath,
  gnisUrl,
  isNullIsland,
} from './gnisSource';

describe('the water classes', () => {
  it('covers every class our own vocabulary can receive', () => {
    // Four of these map onto `lakePond`, `reservoir`, `wetland` and `bay`. The last three were added
    // by the audit: `bay` was half-served, because GNIS files a great many tidal and semi-enclosed
    // waters under `Harbor` and `Channel`, and `Gut` is the New England term for a narrows.
    expect([...GNIS_WATER_CLASSES].sort()).toEqual([
      'Bay',
      'Channel',
      'Gut',
      'Harbor',
      'Lake',
      'Reservoir',
      'Swamp',
    ]);
  });

  it('excludes Stream and Spring, which have one coordinate somewhere along a line', () => {
    // Letting a stream name the polygon its single published coordinate falls inside would christen
    // a lake after the brook running through it.
    expect(GNIS_WATER_CLASSES.has('Stream')).toBe(false);
    expect(GNIS_WATER_CLASSES.has('Spring')).toBe(false);
  });

  it('excludes Basin, which GNIS uses for a drainage basin rather than water', () => {
    expect(GNIS_WATER_CLASSES.has('Basin')).toBe(false);
  });
});

describe('null island', () => {
  it('recognises GNIS’s "no coordinate", which is a real place in the Gulf of Guinea', () => {
    // Read as a position it piles every unplaced feature into one grid cell off Africa; read as a
    // name source it does nothing at all, which is worse because nothing would say so.
    expect(isNullIsland(0, 0)).toBe(true);
  });

  it('does not refuse a genuine coordinate on either axis', () => {
    expect(isNullIsland(0, -70)).toBe(false);
    expect(isNullIsland(44, 0)).toBe(false);
    expect(isNullIsland(44, -70)).toBe(false);
  });
});

describe('the header', () => {
  const header = ['feature_id', 'feature_name', 'feature_class', 'prim_lat_dec', 'prim_long_dec'];

  it('locates every column the merge reads', () => {
    expect(gnisColumnIndexes(header)).toEqual({ id: 0, name: 1, class: 2, lat: 3, lng: 4 });
  });

  it('survives a missing feature_id — a lost bridge, not a lost lane', () => {
    // D105's id half is worth having and is not worth refusing to run over: without a name the
    // gazetteer cannot decide admission, and admission is what the lane is for.
    expect(gnisColumnIndexes(header.slice(1))?.id).toBeUndefined();
    expect(gnisColumnIndexes(header.slice(1))?.name).toBe(0);
  });

  it('refuses a header missing a coordinate, rather than reading NaN into the grid', () => {
    expect(gnisColumnIndexes(['feature_name', 'feature_class', 'prim_lat_dec'])).toBeNull();
  });

  it('is order-independent, because the publisher’s column order is not a promise', () => {
    const shuffled = [
      'prim_long_dec',
      'feature_class',
      'feature_id',
      'prim_lat_dec',
      'feature_name',
    ];
    expect(gnisColumnIndexes(shuffled)).toEqual({ id: 2, name: 4, class: 1, lat: 3, lng: 0 });
  });

  it('names the columns once, so the reader and the archiver cannot disagree', () => {
    expect(Object.values(GNIS_COLUMNS)).toEqual(
      expect.arrayContaining(['feature_name', 'feature_class', 'feature_id']),
    );
  });
});

describe('the staged artifact', () => {
  it('covers the five states', () => {
    expect([...GNIS_STATE_CODES]).toEqual(['ME', 'NH', 'VT', 'MA', 'NY']);
  });

  it('builds the staged URL — which carries NO vintage, hence the archive', () => {
    // `DomesticNames_VT_Text.zip` is overwritten in place on every publication, so today's gazetteer
    // is not recoverable tomorrow. And a GNIS name decides admission (D96), not just labelling, so an
    // un-pinned gazetteer means the corpus changes shape between runs for a reason nothing records.
    expect(gnisUrl('VT')).toBe(
      'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_VT_Text.zip',
    );
  });

  it('reads the extracted text from the permanent archive, never from scratch', () => {
    expect(gnisTextPath('ME')).toContain('.raw-gnis');
    expect(gnisTextPath('ME')).toContain('DomesticNames_ME.txt');
  });
});
