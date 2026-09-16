import { describe, expect, it } from 'vitest';
import { dedupeDestinations, gazetteerToDestinations } from './standing';

describe('gazetteerToDestinations', () => {
  it('reads name and region, ignores the tallies, and skips blank rows', () => {
    const csv = [
      'water_body,messages,mentions,region,region_breakdown',
      'Lake Champlain,54,65,VT,VT:48;NY:34',
      'Malletts Bay,53,81,VT,VT:53',
      ',1,1,NH,NH:1',
      '',
    ].join('\n');
    expect(gazetteerToDestinations(csv)).toEqual([
      { name: 'Lake Champlain', state: 'VT', sources: ['community'] },
      { name: 'Malletts Bay', state: 'VT', sources: ['community'] },
    ]);
  });

  it('refuses a file without the two columns it needs', () => {
    expect(() => gazetteerToDestinations('name,state\nMorey,VT')).toThrow(/water_body/);
  });
});

describe('dedupeDestinations', () => {
  it('folds a lake on both lists into one entry, case-insensitively, keeping the first', () => {
    const out = dedupeDestinations([
      [{ name: 'Lake Morey', state: 'VT', sources: ['atlas'], near: { lat: 43.9, lng: -72.1 } }],
      [
        { name: 'lake morey', state: 'VT', sources: ['community'] },
        { name: 'Lake Morey', state: 'NH', sources: ['community'] },
      ],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.near).toBeDefined();
    expect(out[1]?.state).toBe('NH');
  });
});
