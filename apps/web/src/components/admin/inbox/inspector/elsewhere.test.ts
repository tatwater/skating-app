import { describe, expect, it } from 'vitest';

import {
  ADMIT_ITEM,
  DRAWN_ITEM,
  NEWFOUND,
  PHOTO_ITEM,
  PLACE_ITEM,
  TICKET_ITEM,
} from '../list/inboxFixtures';
import { ELSEWHERE, elsewhereFor, HANDLER_KEYS } from './elsewhere';
import { HANDLERS, handlerKeyOf } from './handlerRegistry';

const targets = (e: ReturnType<typeof elsewhereFor>) => e?.links.map((l) => l.to) ?? null;

describe('where an item without its handler is decided', () => {
  it('leaves no kind a dead end: each has its handler, or a page to point at', () => {
    for (const key of HANDLER_KEYS) {
      expect(HANDLERS.has(key) || ELSEWHERE[key] !== undefined, key).toBe(true);
    }
  });

  it('points a photo flag at the old Flags page', () => {
    expect(handlerKeyOf(PHOTO_ITEM)).toBe('flag:photo');
    expect(targets(elsewhereFor('flag:photo', PHOTO_ITEM, true))).toEqual(['/admin/flags']);
  });

  it('says nothing for a request: its handler has landed', () => {
    expect(HANDLERS.has('request')).toBe(true);
    expect(elsewhereFor('request', ADMIT_ITEM, true)).toBeNull();
  });

  it('points a place ask at the Requests page and the body’s old editor, where it is drawn', () => {
    expect(targets(elsewhereFor('place', PLACE_ITEM, true))).toEqual([
      '/admin/water/requests',
      `/admin/water/${NEWFOUND.waterBodyId}`,
    ]);
  });

  it('points a drawn body at the old Water bodies list', () => {
    expect(targets(elsewhereFor('drawn', DRAWN_ITEM, true))).toEqual(['/admin/water']);
  });

  it('points a ticket at the old Support page — only for a viewer who reads Support', () => {
    expect(targets(elsewhereFor('ticket', TICKET_ITEM, true))).toEqual(['/admin/support']);
    expect(elsewhereFor('ticket', TICKET_ITEM, false)).toBeNull();
  });

  it('says nothing for a kind whose handler has landed', () => {
    expect(elsewhereFor('access', ADMIT_ITEM, true)).toBeNull();
  });
});
