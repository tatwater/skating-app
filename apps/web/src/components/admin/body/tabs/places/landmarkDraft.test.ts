import { describe, expect, it } from 'vitest';

import {
  aliasList,
  dropHeading,
  dropModeBar,
  dropNote,
  droppedReceipt,
  landmarkSaveBlocker,
  moveModeBar,
  startLandmarkDraft,
  withPoint,
} from './landmarkDraft';

const AT = { lat: 43.64, lng: -72.16 };

describe('a landmark being dropped', () => {
  it('starts with no kind and no point; each start is its own session', () => {
    const a = startLandmarkDraft({ kind: 'new' });
    const b = startLandmarkDraft({ kind: 'new' });
    expect(a).toMatchObject({ name: '', kind: null, aliases: [], point: null, focus: null });
    expect(b.session).toBeGreaterThan(a.session);
  });

  it('a proposal starts at the skater’s point, and the camera goes there', () => {
    const d = startLandmarkDraft(
      { kind: 'proposal', requestId: 'r1', askers: 2 },
      { name: 'Bird Poop Rock', aliases: ['BPR'], point: AT },
    );
    expect(d).toMatchObject({ name: 'Bird Poop Rock', aliases: ['BPR'], point: AT });
    expect(d.focus).toEqual({ point: AT });
  });

  it('a pick moves the point and keeps everything else', () => {
    const d = { ...startLandmarkDraft({ kind: 'new' }), name: 'Cove' };
    const moved = withPoint(d, AT);
    expect(moved).toEqual({ ...d, point: AT });
  });

  it('asks for a name, then a kind, then a point, in that order', () => {
    let d = startLandmarkDraft({ kind: 'new' });
    expect(landmarkSaveBlocker(d)).toBe('It needs a name');
    d = { ...d, name: '  ' };
    expect(landmarkSaveBlocker(d)).toBe('It needs a name');
    d = { ...d, name: 'Cove' };
    expect(landmarkSaveBlocker(d)).toBe('Choose what kind of place it is');
    d = { ...d, kind: 'bay' };
    expect(landmarkSaveBlocker(d)).toBe('Click the map where it is');
    expect(landmarkSaveBlocker(withPoint(d, AT))).toBeNull();
  });

  it('sends the other spellings trimmed, none empty and none the name again', () => {
    const d = {
      ...startLandmarkDraft({ kind: 'new' }),
      name: 'The Gut ',
      aliases: [' Gut', '', 'the gut', 'Gut Cove'],
    };
    expect(aliasList(d)).toEqual(['Gut', 'Gut Cove']);
  });

  it('says on the map what a click does next', () => {
    const d = startLandmarkDraft({ kind: 'new' });
    expect(dropModeBar(d)).toEqual({ mode: 'Landmark mode', line: 'Click the map where it is.' });
    expect(dropModeBar(withPoint(d, AT)).line).toBe(
      'Click somewhere else, or drag the mark, to move it.',
    );
    expect(moveModeBar('Black Point')).toEqual({
      mode: 'Landmark mode',
      line: 'Click where Black Point really is, or drag it. Each move saves.',
    });
  });

  it('heads and notes the card by what the drop answers, counting who asked', () => {
    const own = startLandmarkDraft({ kind: 'new' });
    const one = startLandmarkDraft({ kind: 'place-name', corpusNameId: 'n', messages: 1 });
    const many = startLandmarkDraft({ kind: 'place-name', corpusNameId: 'n', messages: 1200 });
    const asked = startLandmarkDraft({ kind: 'proposal', requestId: 'r', askers: 1 });
    const askedMany = startLandmarkDraft({ kind: 'proposal', requestId: 'r', askers: 3 });
    expect([own, one, asked].map(dropHeading)).toEqual([
      'A new landmark',
      'A name from the emails',
      'A skater’s proposal',
    ]);
    expect(dropNote(own)).toBeNull();
    expect(dropNote(one)).toMatch(/One email uses it\.$/);
    expect(dropNote(many)).toMatch(/1,200 emails use it\.$/);
    expect(dropNote(asked)).toMatch(/^Adding it answers the skater who asked\./);
    expect(dropNote(askedMany)).toMatch(/^Adding it answers all 3 skaters who asked\./);
  });

  it('names the landmark on its receipt, and says what else the save did', () => {
    const name = (d: ReturnType<typeof startLandmarkDraft>) => ({ ...d, name: ' Cove ' });
    expect(droppedReceipt(name(startLandmarkDraft({ kind: 'new' })))).toEqual({
      title: 'Added · Cove',
    });
    expect(
      droppedReceipt(
        name(startLandmarkDraft({ kind: 'place-name', corpusNameId: 'n', messages: 2 })),
      ),
    ).toEqual({ title: 'Placed · Cove', description: 'The name is off the emails’ list.' });
    expect(
      droppedReceipt(name(startLandmarkDraft({ kind: 'proposal', requestId: 'r', askers: 2 }))),
    ).toEqual({ title: 'Added · Cove', description: 'The skaters who asked for it are answered.' });
  });
});
