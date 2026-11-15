import { describe, expect, it } from 'vitest';

import { modeAt, usesOldShell } from '../shell/consoleNav';
import { type ActionRow, CORPUS_TASKS, INBOX_LANES } from './overviewData';
import type { OverviewTarget } from './overviewLinks';
import { consolePathFor, feedTargetPath } from './overviewRoutes';

/** Every target type the audit trail writes — the compile fails if the server adds one. */
const TARGET_TYPES = [
  'report',
  'post',
  'comment',
  'photo',
  'user',
  'waterbody',
  'contentFlag',
  'hazard',
  'bodyFeature',
  'waterBodySubArea',
  'hazardRecurrence',
  'putIn',
  'parkingArea',
  'accessAlert',
  'waterBodyRequest',
  'bodyLandmark',
  'corpusPlaceName',
] as const satisfies readonly ActionRow['targetType'][];
const allListed: Exclude<ActionRow['targetType'], (typeof TARGET_TYPES)[number]> extends never
  ? true
  : false = true;

const PEOPLE_LISTS = ['staff', 'new', 'suspended', 'banned', 'leaving'] as const;

describe('Home’s links, until the new modes land', () => {
  const targets: OverviewTarget[] = [
    { kind: 'inbox' },
    ...INBOX_LANES.map((lane) => ({ kind: 'inbox', lane }) as const),
    { kind: 'corpus' },
    ...CORPUS_TASKS.map((task) => ({ kind: 'corpus', task }) as const),
    { kind: 'machinery' },
    { kind: 'people' },
    ...PEOPLE_LISTS.map((list) => ({ kind: 'people', list }) as const),
    { kind: 'body', id: 'k1/7' },
  ];

  it.each(targets)(
    'sends %o to an old page still standing, or a mode that has landed',
    (target) => {
      const path = consolePathFor(target) as string;
      expect(path).not.toBeNull();
      if (target.kind === 'body') expect(modeAt(path)?.id).toBe('bodies');
      else expect(usesOldShell(path)).toBe(true);
    },
  );

  it('sends the lanes to the pages that work them', () => {
    expect(consolePathFor({ kind: 'inbox', lane: 'safety' })).toBe('/admin/flags');
    expect(consolePathFor({ kind: 'inbox', lane: 'support' })).toBe('/admin/support');
    expect(consolePathFor({ kind: 'inbox', lane: 'placesAsked' })).toBe('/admin/water/requests');
    expect(consolePathFor({ kind: 'corpus', task: 'placeNames' })).toBe('/admin/water/place-names');
    expect(consolePathFor({ kind: 'corpus', task: 'duplicates' })).toBe('/admin/water/review');
  });

  it('opens a most-reported body in its Body console, the id escaped', () => {
    expect(consolePathFor({ kind: 'body', id: 'k1/7' })).toBe('/admin/body/k1%2F7');
  });

  it('has no page for the ledger yet', () => {
    expect(consolePathFor({ kind: 'ledger' })).toBeNull();
  });
});

describe('the audit feed’s rows', () => {
  it('lists every target type the trail writes', () => {
    expect(allListed).toBe(true);
  });

  it.each(TARGET_TYPES)(
    'opens a %s on an old page still standing, or a mode that has landed',
    (type) => {
      const path = feedTargetPath({ type, id: 'k1/7', label: 'x' }) as string;
      expect(path).not.toBeNull();
      if (type === 'waterbody') expect(modeAt(path)?.id).toBe('bodies');
      else expect(usesOldShell(path)).toBe(true);
    },
  );

  it('opens a body or a person on its own page, the id escaped', () => {
    expect(feedTargetPath({ type: 'waterbody', id: 'k1/7', label: 'Lake' })).toBe(
      '/admin/body/k1%2F7',
    );
    expect(feedTargetPath({ type: 'user', id: 'u1', label: 'Rob' })).toBe('/admin/users/u1');
  });

  it('opens nothing for a type the trail doesn’t write', () => {
    expect(feedTargetPath({ type: 'invoice', id: 'i1', label: 'Invoice' })).toBeNull();
  });
});
