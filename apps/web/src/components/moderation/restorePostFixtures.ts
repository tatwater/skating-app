/**
 * The Post-restore chooser's three states, as `moderation.postRestoreChoices` returns them — shared
 * by the story and the test. Dates are fixed (the boards' week of January 2027), never the clock.
 */
import type { Id } from '@skating/convex/dataModel';
import type { PostRestoreChoices } from './RestorePost';

const JAN = (day: number, hour = 12) => Date.UTC(2027, 0, day, hour);
const MOD = { userId: 'p_mod', username: 'sarah', displayName: 'Sarah Berman' };

export const id = (s: string) => s as Id<'reports'>;

/** Hidden by its own hide: a plain restore brings a Report back, so no chooser opens. */
export const PLAIN: PostRestoreChoices = {
  postStatus: 'hidden',
  plainRestoreBringsBack: true,
  restorable: true,
  members: [
    {
      reportId: id('r_returns'),
      status: 'hidden',
      waterBodyName: 'Lake Morey',
      skateEndTime: JAN(14),
      down: { action: 'hide', by: MOD, at: JAN(15), reason: 'Second unsafe claim' },
      standing: 'returns',
    },
  ],
};

/** Every Report taken down on its own, one withdrawn by its author: the chooser, two choosable. */
export const MIXED: PostRestoreChoices = {
  postStatus: 'removed',
  plainRestoreBringsBack: false,
  restorable: true,
  members: [
    {
      reportId: id('r_hidden'),
      status: 'hidden',
      waterBodyName: 'Lake Morey',
      skateEndTime: JAN(14),
      down: { action: 'hide', by: MOD, at: JAN(15), reason: 'Thickness looks mistyped' },
      standing: 'choose',
    },
    {
      reportId: id('r_removed'),
      status: 'removed',
      waterBodyName: 'Lake Fairlee',
      skateEndTime: JAN(13),
      down: { action: 'remove', by: MOD, at: JAN(15, 13), reason: 'Photo shows a license plate' },
      standing: 'choose',
    },
    {
      reportId: id('r_withdrawn'),
      status: 'removed',
      waterBodyName: 'Lake Morey',
      skateEndTime: JAN(12),
      down: { action: 'author_delete', by: null, at: JAN(13), reason: 'Deleted by the author' },
      standing: 'author_deleted',
    },
  ],
};

/** Every Report withdrawn by its author: nothing can bring the Post back. */
export const NOTHING: PostRestoreChoices = {
  postStatus: 'removed',
  plainRestoreBringsBack: false,
  restorable: false,
  members: [
    {
      reportId: id('r_gone1'),
      status: 'removed',
      waterBodyName: 'Lake Morey',
      skateEndTime: JAN(12),
      down: { action: 'author_delete', by: null, at: JAN(13), reason: 'Deleted by the author' },
      standing: 'author_deleted',
    },
    {
      reportId: id('r_gone2'),
      status: 'removed',
      waterBodyName: 'Lake Morey',
      skateEndTime: JAN(12, 15),
      down: { action: 'author_delete', by: null, at: JAN(13), reason: 'Deleted by the author' },
      standing: 'author_deleted',
    },
  ],
};
