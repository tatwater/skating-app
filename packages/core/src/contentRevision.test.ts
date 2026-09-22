import { describe, expect, it } from 'vitest';
import {
  describeRevisionValue,
  diffContentBlocks,
  revisionHistory,
  touchedAClaim,
} from './contentRevision';

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 0, 10, 20);

describe('describeRevisionValue', () => {
  it('reads a thickness block the way the report page does — the reading, the method, the word', () => {
    expect(
      describeRevisionValue('iceThickness', {
        readings: [{ method: 'measured', valueCm: 10.16, supportable: true }],
        scope: 'at_spot',
      }),
    ).toBe('4″ (measured), supportable — at spot');
  });

  it('names a located chip with where it was', () => {
    expect(
      describeRevisionValue(
        'iceTypes',
        [{ type: 'black_ice', where: { sector: 'N' } }, { type: 'snow_ice' }],
        { bayNames: {} },
      ),
    ).toBe('black ice (north end), snow ice');
  });

  it('counts photos rather than listing ids — a moderator wants "three became one"', () => {
    expect(describeRevisionValue('photoIds', ['a', 'b', 'c'])).toBe('3 photos');
    expect(describeRevisionValue('photoIds', ['a'])).toBe('1 photo');
    expect(describeRevisionValue('photoIds', [])).toBeNull();
  });

  it('reads a moved put-in as a coordinate, and a dropped one as nothing', () => {
    expect(describeRevisionValue('point', { lat: 43.912345678, lng: -72.123456789 })).toBe(
      '43.91235, -72.12346',
    );
    expect(describeRevisionValue('point', { lat: 43.9 })).toBeNull();
  });

  it('reads the plain-shaped fields as themselves', () => {
    expect(describeRevisionValue('showPutIn', false)).toBe('no');
    expect(describeRevisionValue('showPutIn', true)).toBe('yes');
    expect(describeRevisionValue('suitability', 'dont_go')).toBe('dont go');
    expect(describeRevisionValue('skateStartTime', 'not a time')).toBeNull();
  });

  /** Snow and the weather block have no formatter of their own; their set fields are the reading. */
  it('reads an object block as its set fields, in a stable order', () => {
    expect(
      describeRevisionValue('snow', { coverage: 'patches', depthCm: 5, impediment: undefined }),
    ).toBe('coverage: patches, depth cm: 5');
    expect(describeRevisionValue('snow', {})).toBeNull();
  });

  it('leaves the author’s own prose alone — the underscores are the enums’, not the writing’s', () => {
    expect(describeRevisionValue('notes', 'the plank_by the ramp')).toBe('the plank_by the ramp');
    expect(describeRevisionValue('title', 'Crystal_Lake 12/6')).toBe('Crystal_Lake 12/6');
    // …and an edit that only opened one out is still an edit, not a no-op.
    expect(diffContentBlocks({ title: 'Crystal_Lake' }, { title: 'Crystal Lake' })).toHaveLength(1);
  });

  it('is null for what was never said, and for an empty string', () => {
    expect(describeRevisionValue('notes', undefined)).toBeNull();
    expect(describeRevisionValue('notes', '   ')).toBeNull();
    expect(describeRevisionValue('iceTypes', [])).toBeNull();
  });

  it('reads a time in the body’s zone, not the reader’s', () => {
    const at = Date.UTC(2026, 0, 10, 1); // 8 pm the previous day in New York
    expect(describeRevisionValue('skateEndTime', at, { timeZone: TZ })).toContain('Jan 9');
    expect(describeRevisionValue('skateEndTime', at, { timeZone: 'UTC' })).toContain('Jan 10');
  });
});

describe('diffContentBlocks', () => {
  it('lists only what moved, in the sheet’s order, with claims marked', () => {
    const changes = diffContentBlocks(
      { notes: 'Glass.', skateQuality: 'fair', suitability: 'dont_go' },
      { notes: 'Glass all over.', skateQuality: 'good', suitability: 'dont_go' },
    );
    expect(changes.map((c) => c.field)).toEqual(['skateQuality', 'notes']);
    expect(changes[0]).toMatchObject({
      label: 'How was it?',
      before: 'fair',
      after: 'good',
      claim: true,
    });
    // A reworded note is a change, but not a claim — that is the whole point of the mark.
    expect(changes[1]?.claim).toBe(false);
  });

  it('shows a field that was added, and one that was cleared', () => {
    const changes = diffContentBlocks({ notes: 'Thin by the inlet.' }, { skateQuality: 'good' });
    expect(changes).toEqual([
      { field: 'skateQuality', label: 'How was it?', before: null, after: 'good', claim: true },
      {
        field: 'notes',
        label: 'The note about this lake',
        before: 'Thin by the inlet.',
        after: null,
        claim: false,
      },
    ]);
  });

  it('ignores a field neither block carries', () => {
    expect(diffContentBlocks({ notes: 'a' }, { notes: 'a' })).toEqual([]);
  });

  /** A rewrite that lands on the same words is not an edit worth a moderator's attention. */
  it('a value that reads the same is not a change, however it is stored', () => {
    expect(
      diffContentBlocks({ iceTypes: ['black_ice'] }, { iceTypes: [{ type: 'black_ice' }] }),
    ).toEqual([]);
  });
});

describe('revisionHistory', () => {
  const live = { skateQuality: 'good', notes: 'Third.' };

  it('compares each snapshot with what replaced it, and the last with the live row', () => {
    const steps = revisionHistory(
      [
        { replacedAt: NOW + 1000, snapshot: { skateQuality: 'good', notes: 'Second.' } },
        { replacedAt: NOW, snapshot: { skateQuality: 'poor', notes: 'First.' } },
      ],
      live,
    );
    // Oldest first, whatever order the rows arrived in — a mis-ordered pair reports backwards.
    expect(steps.map((s) => s.replacedAt)).toEqual([NOW, NOW + 1000]);
    expect(steps[0]?.changes).toEqual([
      { field: 'skateQuality', label: 'How was it?', before: 'poor', after: 'good', claim: true },
      {
        field: 'notes',
        label: 'The note about this lake',
        before: 'First.',
        after: 'Second.',
        claim: false,
      },
    ]);
    expect(steps[1]?.changes.map((c) => c.field)).toEqual(['notes']);
  });

  it('a row that has never been edited has no history', () => {
    expect(revisionHistory([], live)).toEqual([]);
  });

  it('a save that moved nothing the block carries is a step with no changes', () => {
    const steps = revisionHistory([{ replacedAt: NOW, snapshot: live }], live);
    expect(steps).toEqual([{ replacedAt: NOW, changes: [] }]);
  });
});

describe('touchedAClaim', () => {
  it('is true when any edit moved a field that says something about the ice', () => {
    const wording = revisionHistory([{ replacedAt: NOW, snapshot: { notes: 'First.' } }], {
      notes: 'Second.',
    });
    expect(touchedAClaim(wording)).toBe(false);
    const thickness = revisionHistory(
      [
        {
          replacedAt: NOW,
          snapshot: { iceThickness: { readings: [{ method: 'measured', valueCm: 5 }] } },
        },
      ],
      { iceThickness: { readings: [{ method: 'measured', valueCm: 15 }] } },
    );
    expect(touchedAClaim(thickness)).toBe(true);
  });
});
