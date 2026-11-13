import type { Id } from '@skating/convex/dataModel';
import type { HistoryEntry } from './HistoryPanel';

/**
 * A History trail as `moderation.listActions` returns it, around the boards' "today" (Saturday
 * 16 January 2027, 11:52 in New Hampshire — `BOARD_NOW_NH`): every way a row can end — undo
 * offered, undo that asks a reason, undone, changed since, and the machines' rows that have none.
 * Shared by the stories and the tests; constants only.
 */

const id = (s: string) => s as Id<'moderationActions'>;

const TEAGAN = { userId: 'p-teagan', username: 'teagan', displayName: 'Teagan Atwater' };
const SARAH = { userId: 'p-sarah', username: 'sarah', displayName: 'Sarah Berman' };
const MATT = { userId: 'p-matt', username: 'matt', displayName: 'Matt Steinberg' };

export const HISTORY_ROWS: HistoryEntry[] = [
  {
    id: 'a1',
    action: 'hide',
    targetType: 'report',
    targetId: 'r1',
    reason: 'Second unsafe claim at the beach',
    createdAt: Date.UTC(2027, 0, 16, 16, 41),
    actor: TEAGAN,
    undo: { state: 'available', needsReason: false },
  },
  {
    id: 'a2',
    action: 'restore',
    targetType: 'report',
    targetId: 'r2',
    reason: '',
    createdAt: Date.UTC(2027, 0, 16, 15, 2),
    actor: MATT,
    undo: { state: 'available', needsReason: true },
  },
  {
    id: 'a3',
    action: 'set_water_body_name',
    targetType: 'waterbody',
    targetId: 'b1',
    reason: 'The town’s spelling',
    createdAt: Date.UTC(2027, 0, 15, 21, 14),
    actor: SARAH,
    undo: { state: 'available', needsReason: false },
  },
  {
    id: 'a4',
    action: 'set_curated_boost',
    targetType: 'waterbody',
    targetId: 'b1',
    reason: '',
    createdAt: Date.UTC(2027, 0, 15, 18, 0),
    actor: TEAGAN,
    undo: { state: 'overtaken', byActionId: id('a3') },
  },
  {
    id: 'a5',
    action: 'restore',
    targetType: 'comment',
    targetId: 'c1',
    reason: 'Read it again; it was a joke',
    createdAt: Date.UTC(2027, 0, 14, 14, 30),
    actor: SARAH,
    undoesActionId: 'a6',
    undo: { state: 'unavailable', why: 'Undoing this takes a role you do not hold.' },
  },
  {
    id: 'a6',
    action: 'hide',
    targetType: 'comment',
    targetId: 'c1',
    reason: 'Harassing the reporter',
    createdAt: Date.UTC(2027, 0, 13, 20, 5),
    actor: TEAGAN,
    undo: { state: 'undone', byActionId: id('a5') },
  },
  {
    id: 'a7',
    action: 'activate_body',
    targetType: 'waterbody',
    targetId: 'b2',
    reason: 'A report on a dormant body',
    createdAt: Date.UTC(2027, 0, 3, 13, 0),
    actor: null,
    undo: { state: 'unavailable', why: 'Undo for this is not built yet.' },
  },
  {
    id: 'a8',
    action: 'suspend',
    targetType: 'user',
    targetId: 'u1',
    reason: 'Repeated false reports',
    createdAt: Date.UTC(2026, 9, 3, 15, 0),
    actor: MATT,
    undo: { state: 'available', needsReason: false },
  },
];
