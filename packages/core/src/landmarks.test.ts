import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LANDMARK_KIND_LABELS,
  LANDMARK_KINDS,
  LANDMARK_LABEL_MAX_ZOOM,
  LANDMARK_LABEL_MIN_ZOOM,
  landmarkLabelMinZoom,
  landmarkNameKey,
  landmarkProminence,
} from './landmarks';

describe('landmarkNameKey', () => {
  it('folds the spellings the corpus writes for one place', () => {
    expect(landmarkNameKey("Mallett's Head")).toBe(landmarkNameKey('Malletts head'));
    expect(landmarkNameKey('The Gut')).toBe(landmarkNameKey('gut'));
    expect(landmarkNameKey('Saint Albans Bay')).toBe(landmarkNameKey('St. Albans Bay'));
  });

  it('keeps a "the" that is not leading', () => {
    expect(landmarkNameKey('Over the Rainbow Rock')).toBe('over the rainbow rock');
  });
});

describe('landmarkProminence', () => {
  it('labels every kind', () => {
    for (const kind of LANDMARK_KINDS) expect(LANDMARK_KIND_LABELS[kind]).toBeTruthy();
  });

  it('ranks an island above a standalone restaurant before anyone has said a word', () => {
    expect(landmarkProminence({ kind: 'island' })).toBeGreaterThan(
      landmarkProminence({ kind: 'establishment' }),
    );
  });

  it('lets the community lift a weak kind over a silent strong one', () => {
    expect(landmarkProminence({ kind: 'establishment', corpusMessages: 6 })).toBeGreaterThan(
      landmarkProminence({ kind: 'island' }),
    );
  });

  it('never goes negative and never falls as evidence grows', () => {
    const kind = fc.constantFrom(...LANDMARK_KINDS);
    const count = fc.integer({ min: -5, max: 10_000 });
    const area = fc.option(fc.double({ min: 0, max: 1e9, noNaN: true }), { nil: undefined });
    fc.assert(
      fc.property(kind, count, count, area, fc.nat(50), (k, messages, reports, areaSqM, more) => {
        const base = landmarkProminence({
          kind: k,
          corpusMessages: messages,
          reportCount: reports,
          areaSqM,
        });
        expect(base).toBeGreaterThanOrEqual(0);
        expect(
          landmarkProminence({
            kind: k,
            corpusMessages: messages + more,
            reportCount: reports,
            areaSqM,
          }),
        ).toBeGreaterThanOrEqual(base);
        expect(
          landmarkProminence({
            kind: k,
            corpusMessages: messages,
            reportCount: reports + more,
            areaSqM,
          }),
        ).toBeGreaterThanOrEqual(base);
      }),
    );
  });

  it('stops counting area past a square kilometer', () => {
    expect(landmarkProminence({ kind: 'island', areaSqM: 1e6 })).toBe(
      landmarkProminence({ kind: 'island', areaSqM: 1e8 }),
    );
    expect(landmarkProminence({ kind: 'island', areaSqM: 5_000 })).toBe(
      landmarkProminence({ kind: 'island' }),
    );
  });
});

describe('landmarkLabelMinZoom', () => {
  it('shows a big island sooner than a small one', () => {
    const big = landmarkLabelMinZoom({ kind: 'island', areaSqM: 2_000_000, lat: 44.5 });
    const small = landmarkLabelMinZoom({ kind: 'island', areaSqM: 2_000, lat: 44.5 });
    expect(big).toBeLessThan(small);
  });

  it('shows a well-named point sooner than a silent one', () => {
    expect(landmarkLabelMinZoom({ kind: 'point', corpusMessages: 20, lat: 44.5 })).toBeLessThan(
      landmarkLabelMinZoom({ kind: 'point', lat: 44.5 }),
    );
  });

  it('never leaves the label band, whatever the inputs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LANDMARK_KINDS),
        fc.option(fc.double({ min: 0, max: 1e11, noNaN: true }), { nil: undefined }),
        fc.nat(100_000),
        fc.double({ min: -89, max: 89, noNaN: true }),
        (kind, areaSqM, corpusMessages, lat) => {
          const zoom = landmarkLabelMinZoom({ kind, areaSqM, corpusMessages, lat });
          expect(zoom).toBeGreaterThanOrEqual(LANDMARK_LABEL_MIN_ZOOM);
          expect(zoom).toBeLessThanOrEqual(LANDMARK_LABEL_MAX_ZOOM);
        },
      ),
    );
  });
});
