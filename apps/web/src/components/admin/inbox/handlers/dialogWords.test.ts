import { describeNotification, type NotificationView } from '@skating/core';
import { describe, expect, it } from 'vitest';

import { DRAWN_WORDS } from './Drawn/drawnWords';
import { PLACE_WORDS } from './Place/placeWords';
import { REQUEST_HANDLER_WORDS } from './Request/requestWords';

/**
 * **Each reason dialog says who reads what it asks — and the server agrees.** A note on a decided ask
 * reaches the asker (the moderator_decision sentence's second line); a drawing's rejection reason
 * never reaches the drawer (the resolver drops it, and core's sentence has no line for it). A dialog
 * that says "the asker reads it" must be one whose words the asker is sent, and the other way round.
 */

const NOTE = 'That one is a beaver flowage.';
const decided = (
  about: Extract<NotificationView, { type: 'moderator_decision' }>['about'],
  outcome: Extract<NotificationView, { type: 'moderator_decision' }>['outcome'],
): NotificationView =>
  ({
    id: 'n1',
    type: 'moderator_decision',
    createdAt: 0,
    about,
    outcome,
    body: null,
    note: NOTE,
  }) as unknown as NotificationView;
const sent = (view: NotificationView) => describeNotification(view, {}).detail ?? null;

describe('who reads what each reason dialog asks', () => {
  it('a request’s decline: the asker reads the note, and is sent it', () => {
    expect(REQUEST_HANDLER_WORDS.noteLabel).toBe('Note · the asker reads it');
    expect(sent(decided('admit', 'declined'))).toBe(NOTE);
  });

  it('a takedown’s reason: the asker reads it, and is sent it with the approval', () => {
    expect(REQUEST_HANDLER_WORDS.reasonLabel).toBe('Reason · the asker reads it');
    expect(sent(decided('takedown', 'approved'))).toBe(NOTE);
  });

  it('a place ask’s decline: the asker reads the note, and is sent it', () => {
    expect(PLACE_WORDS.declineLabel).toBe('Note · the asker reads it');
    expect(sent(decided('name_landmark', 'declined'))).toBe(NOTE);
  });

  it('a drawing’s rejection: kept in the audit log, never said to read — and never sent', () => {
    expect(DRAWN_WORDS.rejectLabel).toBe('Reason · kept in the audit log');
    expect(`${DRAWN_WORDS.rejectLabel} ${DRAWN_WORDS.rejectDescription}`).not.toMatch(/reads? it/);
    // Even were a reason on the view, the drawer's sentence has no line for it.
    expect(sent(decided('drawn', 'rejected'))).toBeNull();
  });
});
