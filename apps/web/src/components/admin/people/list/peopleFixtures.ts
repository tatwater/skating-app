/**
 * Board fixtures for the People list (boards 8.1 and 8.2): the board's people, as `people.listPage`
 * returns them, and the lanes as `people.lanes` counts them — on the board's clock, Wednesday
 * 14 October 2026 at local midday. Stories and tests only (`fixturesStayInStories.test.ts`).
 */
import type { Id } from '@skating/convex/dataModel';

import type { LaneEntry, LanesRead, PersonListRow } from './peopleModel';

const at = (month: number, day: number, hour = 12, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();

/** The board's clock: Wed 14 Oct 2026, local midday. */
export const NOW = at(10, 14);

const id = (s: string) => `k17${s.padEnd(29, '0')}` as Id<'profiles'>;

/** A list row with every field at rest; `over` sets what a person differs in. */
export function personRow(
  key: string,
  displayName: string,
  username: string,
  over: Partial<PersonListRow> = {},
): PersonListRow {
  return {
    userId: id(key),
    displayName,
    username,
    profileImageUrl: null,
    role: 'member',
    status: 'active',
    trustClass: null,
    statusSince: null,
    suspension: null,
    statusReason: null,
    restrictions: [],
    restrictedSince: null,
    leavingUntil: null,
    deletedAt: null,
    createdAt: at(1, 14),
    openFlags: { onUser: 0, onContent: 0 },
    appeals: 0,
    ...over,
  };
}

/** Board 8.1: Rob, suspended until Thu 15 Oct, one open flag on his content, one appeal. */
export const ROB = personRow('rob', 'Rob Tremblay', 'rtremblay', {
  status: 'suspended',
  trustClass: 'trusted',
  statusSince: at(10, 10, 19, 48),
  suspension: { until: at(10, 15, 19, 48) },
  statusReason: 'Second unsafe report in a week; cooling off',
  restrictions: ['comments'],
  restrictedSince: at(10, 2),
  openFlags: { onUser: 0, onContent: 1 },
  appeals: 1,
});

/** Board 8.2: the staff, admins first, each by name. */
export const TEAGAN = personRow('teagan', 'Teagan Atwater', 'teagan', {
  role: 'admin',
  trustClass: 'trusted',
  createdAt: at(1, 2),
});
export const SARAH = personRow('sarah', 'Sarah Berman', 'sarah', {
  role: 'admin',
  trustClass: 'leader',
  createdAt: at(1, 9),
  openFlags: { onUser: 0, onContent: 1 },
});
export const MATT = personRow('matt', 'Matt Steinberg', 'matt', {
  role: 'moderator',
  createdAt: at(9, 9),
});

export const KATE = personRow('kate', 'Kate Donovan', 'kdonovan', {
  trustClass: 'expert',
  createdAt: at(10, 12, 9, 30),
});
export const LUC = personRow('luc', 'Luc Pelletier', 'lpelletier', {
  trustClass: 'new',
  createdAt: at(10, 13, 18, 5),
});
export const JAMIE = personRow('jamie', 'Jamie Moreau', 'jm_ice', {
  trustClass: 'trusted',
  createdAt: at(3, 1),
});
export const PAT = personRow('pat', 'Pat Lacasse', 'mascoma_pat', {
  createdAt: at(2, 20),
  restrictions: ['hazards'],
  restrictedSince: at(10, 11),
});

/** A page of a list, done, with nothing short and nothing pending. */
export function page(rows: PersonListRow[], over: Partial<{ isDone: boolean }> = {}) {
  return {
    rows,
    isDone: over.isDone ?? true,
    continueCursor: rows.length === 0 ? '' : `after:${rows.at(-1)?.username}`,
    partial: false,
    reasons: [],
    pending: [],
  };
}

const lane = (
  name: LaneEntry['lane'],
  count: number,
  over: Partial<Omit<LaneEntry, 'lane'>> = {},
): LaneEntry => ({
  lane: name,
  count: { count, capped: false },
  reasons: [],
  pending: [],
  ...over,
});

/** The board's sidebar, an admin's (Appeals open included). */
export const LANES: LanesRead = {
  lanes: [
    lane('everyone', 38),
    lane('staff', 3),
    lane('suspended', 1),
    lane('banned', 0),
    lane('restricted', 1),
    lane('flagged', 1),
    lane('appeals', 1),
    lane('newest', 4),
    lane('leaving', 0),
    lane('deleted', 0),
  ],
  pending: [],
};

/** A moderator's sidebar: no Appeals open (support tickets are an admin's to read). */
export const LANES_MODERATOR: LanesRead = {
  lanes: LANES.lanes.filter((l) => l.lane !== 'appeals'),
  pending: [],
};

/** Straight after a deploy: the rows backfill hasn't finished, so no count is drawn. */
export const LANES_PREPARING: LanesRead = {
  lanes: LANES.lanes.map((l) => ({
    ...l,
    pending: l.lane === 'flagged' ? ['rows', 'flagSubjects'] : ['rows'],
  })),
  pending: ['rows', 'flagSubjects'],
};

/** Only the flag subjects still to stamp: every lane counted but Flagged. */
export const LANES_FLAGS_PREPARING: LanesRead = {
  lanes: LANES.lanes.map((l) => (l.lane === 'flagged' ? { ...l, pending: ['flagSubjects'] } : l)),
  pending: ['flagSubjects'],
};

/** The open flag queue read to its cap: Flagged is a floor, and says why. */
export const LANES_CAPPED: LanesRead = {
  lanes: LANES.lanes.map((l) =>
    l.lane === 'flagged'
      ? { ...l, count: { count: 200, capped: true }, reasons: ['flags_capped'] }
      : l.lane === 'newest'
        ? { ...l, count: { count: 200, capped: true }, reasons: ['count_capped'] }
        : l,
  ),
  pending: [],
};

/** A long Everyone list, for scrolling, paging and the virtualized rows. */
export function manyPeople(n: number): PersonListRow[] {
  const first = ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Gray', 'Harper'];
  const last = ['Allard', 'Bouchard', 'Cote', 'Dube', 'Gagnon', 'Hebert', 'Lavoie', 'Morin'];
  return Array.from({ length: n }, (_, i) => {
    const name = `${first[i % first.length]} ${last[Math.floor(i / first.length) % last.length]}`;
    return personRow(`p${i}`, `${name} ${i + 1}`, `skater${i + 1}`, {
      createdAt: at(1, 1) + i * 3_600_000,
    });
  });
}
