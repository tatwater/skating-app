import { describe, expect, it } from 'vitest';
import {
  defaultVocabulary,
  type ExtractionInput,
  type ExtractionResult,
  ExtractionResultSchema,
} from './contract';
import { attachLandmarks } from './landmarks';

const input: ExtractionInput = {
  text: 'x',
  bodyCandidates: [
    {
      ref: 'champlain',
      name: 'Lake Champlain',
      aliases: [],
      subAreas: [],
      landmarks: [
        { id: 'lm-shel', name: 'Shelburne Point', aliases: [] },
        { id: 'lm-rock', name: 'Bird Poop Rock', aliases: ['the gull rock'] },
      ],
    },
    { ref: 'morey', name: 'Lake Morey', aliases: [], subAreas: [] },
  ],
  vocabulary: defaultVocabulary(),
  timeZone: 'America/New_York',
};

const evidence = { field: 'text' as const, start: 0, end: 1, text: 'x' };

function result(bodyRef: string | null, wheres: Record<string, unknown>[]): ExtractionResult {
  return ExtractionResultSchema.parse({
    reports: [
      {
        bodyRef,
        fields: {
          iceTypes: wheres.map((where) => ({
            value: { type: 'black_ice', where, fields: {} },
            confidence: 0.9,
            evidence,
          })),
          hazards: [
            {
              value: { type: 'thin_ice', where: { placeName: 'by the gull rock' } },
              confidence: 0.9,
              evidence,
            },
          ],
        },
      },
    ],
  });
}

describe('attachLandmarks (D202)', () => {
  it('resolves a named place to its landmark, on every located field', () => {
    const out = attachLandmarks(
      result('champlain', [{ placeName: 'a wind hole off Shelburne Point', sector: 'W' }]),
      input,
    );
    const report = out.reports[0];
    expect(report?.fields.iceTypes[0]?.value.where).toEqual({
      placeName: 'a wind hole off Shelburne Point',
      sector: 'W',
      landmarkId: 'lm-shel',
    });
    expect(report?.fields.hazards[0]?.value.where?.landmarkId).toBe('lm-rock');
  });

  it('keeps a candidate id the engine gave, and drops one that is not this body’s', () => {
    const out = attachLandmarks(
      result('champlain', [
        { placeName: 'the rock', landmarkId: 'lm-rock' },
        { placeName: 'somewhere', landmarkId: 'lm-invented' },
        { sector: 'N' },
      ]),
      input,
    );
    const wheres = out.reports[0]?.fields.iceTypes.map((f) => f.value.where);
    expect(wheres).toEqual([
      { placeName: 'the rock', landmarkId: 'lm-rock' },
      { placeName: 'somewhere' },
      { sector: 'N' },
    ]);
  });

  it('leaves a body with no landmarks, and a report with no body, as they were', () => {
    const noLandmarks = attachLandmarks(result('morey', [{ placeName: 'Shelburne Point' }]), input);
    expect(noLandmarks.reports[0]?.fields.iceTypes[0]?.value.where).toEqual({
      placeName: 'Shelburne Point',
    });
    const noBody = attachLandmarks(
      result(null, [{ placeName: 'Shelburne Point', landmarkId: 'lm-shel' }]),
      input,
    );
    expect(noBody.reports[0]?.fields.iceTypes[0]?.value.where).toEqual({
      placeName: 'Shelburne Point',
    });
  });
});
