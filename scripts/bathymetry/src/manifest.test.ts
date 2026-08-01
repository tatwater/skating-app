import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  diffManifests,
  normalizeDescriptor,
  objectIdField,
  worstSeverity,
} from './manifest';
import type { RawManifest } from './types';

/** A descriptor shaped like NH GRANIT's real one, which is what most of this was written against. */
const NH_DESCRIPTOR_JSON = {
  name: 'bathymetry_lakes_lines',
  geometryType: 'esriGeometryPolyline',
  maxRecordCount: 2000,
  copyrightText: 'New Hampshire Department of Environmental Services \nNew Hampshire Fish and Game',
  description: 'Provides bathymetric depth contours in feet for New Hampshire lakes…',
  spatialReference: { wkid: 102100, latestWkid: 3857 },
  advancedQueryCapabilities: { supportsPagination: true },
  supportedQueryFormats: 'JSON,geoJSON,PBF',
  fields: [
    { name: 'fid', type: 'esriFieldTypeOID' },
    { name: 'lake', type: 'esriFieldTypeString' },
    { name: 'depth', type: 'esriFieldTypeDouble' },
  ],
};

describe('normalizeDescriptor', () => {
  const d = normalizeDescriptor(NH_DESCRIPTOR_JSON);

  it('keeps the fields we depend on', () => {
    expect(d.name).toBe('bathymetry_lakes_lines');
    expect(d.geometryType).toBe('esriGeometryPolyline');
    expect(d.maxRecordCount).toBe(2000);
    expect(d.fields).toHaveLength(3);
  });

  it('prefers latestWkid over wkid', () => {
    expect(d.spatialReference).toBe(3857);
  });

  it('reads supportsPagination out of advancedQueryCapabilities', () => {
    expect(d.supportsPagination).toBe(true);
  });

  it('collapses whitespace in the copyright so a reformat is not read as a licence change', () => {
    // NH's real copyrightText carries an embedded newline and a trailing space.
    expect(d.copyrightText).toBe(
      'New Hampshire Department of Environmental Services New Hampshire Fish and Game',
    );
  });

  it('leaves absent fields absent rather than defaulting them', () => {
    // "The agency stopped publishing a copyright" and "we defaulted it to empty" must stay
    // distinguishable, or `verify` reports drift that never happened.
    const bare = normalizeDescriptor({ fields: [] });
    expect(bare.copyrightText).toBeUndefined();
    expect(bare.spatialReference).toBeUndefined();
    expect(bare.supportsPagination).toBeUndefined();
  });

  it('survives junk instead of crashing discovery', () => {
    expect(normalizeDescriptor(null).fields).toEqual([]);
    expect(normalizeDescriptor({ fields: 'nope' }).fields).toEqual([]);
    expect(normalizeDescriptor({ fields: [{ noName: 1 }] }).fields).toEqual([]);
  });

  it('defaults a field with no declared type rather than dropping the field', () => {
    expect(normalizeDescriptor({ fields: [{ name: 'depth' }] }).fields).toEqual([
      { name: 'depth', type: 'unknown' },
    ]);
  });

  it('treats an all-whitespace copyright as no copyright', () => {
    expect(
      normalizeDescriptor({ fields: [], copyrightText: '   \n ' }).copyrightText,
    ).toBeUndefined();
  });
});

describe('objectIdField', () => {
  it('finds the OID column by type, not by name', () => {
    // NH calls it `fid`; guessing `OBJECTID` would produce unordered, overlapping pages.
    expect(objectIdField(normalizeDescriptor(NH_DESCRIPTOR_JSON))).toBe('fid');
  });

  it('returns undefined when the layer declares none', () => {
    expect(
      objectIdField({ fields: [{ name: 'depth', type: 'esriFieldTypeDouble' }] }),
    ).toBeUndefined();
  });
});

describe('buildManifest', () => {
  it('omits optional keys entirely rather than writing undefined', () => {
    const m = buildManifest({
      key: 'nh-granit-contours',
      fetchedAt: '2026-07-31T00:00:00.000Z',
      sourceUrl: 'https://example.gov/FeatureServer/0',
      sourceKind: 'arcgis',
      files: [],
    });
    expect(Object.keys(m)).toEqual(['key', 'fetchedAt', 'source', 'files']);
    expect(m.source.format).toBeUndefined();
  });

  it('carries format, count, service and validators when given', () => {
    const m = buildManifest({
      key: 'k',
      fetchedAt: '2026-07-31T00:00:00.000Z',
      sourceUrl: 'https://example.gov/x.zip',
      sourceKind: 'file',
      format: 'geojson',
      files: [{ name: 'x.zip', bytes: 10, sha256: 'abc' }],
      recordCount: 3,
      service: { fields: [] },
      http: { etag: '"e1"' },
    });
    expect(m.source.format).toBe('geojson');
    expect(m.recordCount).toBe(3);
    expect(m.http?.etag).toBe('"e1"');
  });
});

const BASE: RawManifest = {
  key: 'nh-granit-contours',
  fetchedAt: '2026-07-31T00:00:00.000Z',
  source: { url: 'https://example.gov/FeatureServer/0', kind: 'arcgis' },
  files: [{ name: 'page-00000.json.gz', bytes: 100, sha256: 'aa' }],
  recordCount: 9285,
  service: normalizeDescriptor(NH_DESCRIPTOR_JSON),
  http: { etag: '"v1"' },
};

describe('diffManifests', () => {
  it('reports no drift against an identical snapshot', () => {
    const report = diffManifests(BASE, {
      recordCount: 9285,
      service: BASE.service,
      http: BASE.http,
    });
    expect(report.changed).toBe(false);
    expect(worstSeverity(report)).toBeUndefined();
  });

  it('calls a removed field breaking — the failure that reads as success', () => {
    const service = normalizeDescriptor({
      ...NH_DESCRIPTOR_JSON,
      fields: NH_DESCRIPTOR_JSON.fields.filter((f) => f.name !== 'depth'),
    });
    const report = diffManifests(BASE, { service });
    expect(worstSeverity(report)).toBe('breaking');
    expect(report.findings[0]?.message).toContain('depth');
  });

  it('calls a retyped field breaking — the name survives and every numeric read becomes NaN', () => {
    const service = normalizeDescriptor({
      ...NH_DESCRIPTOR_JSON,
      fields: [
        { name: 'fid', type: 'esriFieldTypeOID' },
        { name: 'lake', type: 'esriFieldTypeString' },
        { name: 'depth', type: 'esriFieldTypeString' },
      ],
    });
    const report = diffManifests(BASE, { service });
    expect(worstSeverity(report)).toBe('breaking');
    expect(report.findings.some((f) => f.message.includes('depth changed type'))).toBe(true);
  });

  it('calls a geometry-type change breaking', () => {
    const service = normalizeDescriptor({
      ...NH_DESCRIPTOR_JSON,
      geometryType: 'esriGeometryPoint',
    });
    const report = diffManifests(BASE, { service });
    expect(worstSeverity(report)).toBe('breaking');
  });

  it('calls an added field cosmetic — new columns do not break a transform', () => {
    const service = normalizeDescriptor({
      ...NH_DESCRIPTOR_JSON,
      fields: [...NH_DESCRIPTOR_JSON.fields, { name: 'surveyed_on', type: 'esriFieldTypeDate' }],
    });
    const report = diffManifests(BASE, { service });
    expect(worstSeverity(report)).toBe('cosmetic');
  });

  it('reports a record-count change with a signed delta', () => {
    const report = diffManifests(BASE, { recordCount: 9400 });
    expect(worstSeverity(report)).toBe('notable');
    expect(report.findings[0]?.message).toContain('+115');
  });

  it('flags a changed copyright, because it changes what we may render', () => {
    const service = { ...normalizeDescriptor(NH_DESCRIPTOR_JSON), copyrightText: 'NHDES only' };
    const report = diffManifests(BASE, { service });
    expect(worstSeverity(report)).toBe('notable');
    expect(report.findings.some((f) => f.message.includes('copyright'))).toBe(true);
  });

  it('flags a copyright that disappeared', () => {
    const service = normalizeDescriptor({ ...NH_DESCRIPTOR_JSON, copyrightText: '' });
    const report = diffManifests(BASE, { service });
    expect(report.findings.some((f) => f.message.includes('(none)'))).toBe(true);
  });

  it('notices a source URL move', () => {
    const report = diffManifests(BASE, {
      source: { url: 'https://example.gov/FeatureServer/1', kind: 'arcgis' },
    });
    expect(worstSeverity(report)).toBe('notable');
  });

  it('reports a moved HTTP validator on its own as notable', () => {
    const report = diffManifests(BASE, { http: { etag: '"v2"' } });
    expect(worstSeverity(report)).toBe('notable');
    expect(report.findings[0]?.message).toContain('republished');
  });

  it('demotes a moved validator to cosmetic when it is corroborated by a real change', () => {
    // The validator moving is the *symptom*; the count change is the finding. Reporting both at
    // notable would double-count one republication.
    const report = diffManifests(BASE, { recordCount: 9400, http: { etag: '"v2"' } });
    expect(report.findings.filter((f) => f.severity === 'notable')).toHaveLength(1);
    expect(report.findings.some((f) => f.severity === 'cosmetic')).toBe(true);
  });

  it('stays silent about fields when the probe could not read a descriptor', () => {
    // A partial `next` means "we did not check", never "the fields are gone".
    expect(diffManifests(BASE, {}).changed).toBe(false);
  });
});
