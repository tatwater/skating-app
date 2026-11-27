import { describe, expect, it } from 'vitest';
import { routerTarget } from '@/lib/routerTarget';
import { taskLaneById } from '../corpus/taskLanes';
import { modeAt, usesOldShell } from '../shell/consoleNav';
import { type ActionRow, CORPUS_TASKS, type CorpusTask, INBOX_LANES } from './overviewData';
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
  'supportTicket',
  'importRun',
] as const satisfies readonly ActionRow['targetType'][];
const allListed: Exclude<ActionRow['targetType'], (typeof TARGET_TYPES)[number]> extends never
  ? true
  : false = true;

/** The audit targets the Inbox opens: an ask, a ticket, a flag's item, a decision on content. */
const INBOX_TARGETS = new Set([
  'waterBodyRequest',
  'supportTicket',
  'contentFlag',
  'report',
  'post',
  'comment',
  'photo',
  'hazard',
]);

const PEOPLE_LISTS = ['staff', 'new', 'suspended', 'banned', 'leaving'] as const;

describe('Home’s links, until the new modes land', () => {
  const targets: OverviewTarget[] = [
    { kind: 'inbox' },
    ...INBOX_LANES.map((lane) => ({ kind: 'inbox', lane }) as const),
    { kind: 'machinery' },
    { kind: 'body', id: 'k1/7' },
  ];

  it.each(targets)(
    'sends %o to an old page still standing, or a mode that has landed',
    (target) => {
      const path = consolePathFor(target) as string;
      expect(path).not.toBeNull();
      if (target.kind === 'body') expect(modeAt(path)?.id).toBe('corpus');
      // Every Inbox lane is the Inbox's now (B01-5e and B01-5f retired the last old pages).
      else if (target.kind === 'inbox') expect(modeAt(routerTarget(path).to)?.id).toBe('inbox');
      else expect(usesOldShell(path)).toBe(true);
    },
  );

  /**
   * Each Corpus row, task by task: a lane built opens in the Corpus mode (`?lane=`), every other
   * still opens the old page that does its work — never the library's default lane (D293). The
   * table pins the whole list, so a lane that lands (7b–7d) moves its row here, and the last PR
   * drops the old-page half.
   */
  const CORPUS_PATHS: Record<CorpusTask | 'none', string> = {
    none: '/admin/water/review',
    duplicates: '/admin/water/review',
    nameConflicts: '/admin/corpus?lane=name-conflicts',
    classConflicts: '/admin/corpus?lane=class-conflicts',
    contested: '/admin/water/review',
    orphanBays: '/admin/water/review',
    chordRefits: '/admin/water/review',
    placeNames: '/admin/water/place-names',
    preIcePass: '/admin/water/standing',
    enrichment: '/admin/water/review',
  };
  it.each(Object.entries(CORPUS_PATHS))('opens the Corpus row %s at %s', (task, path) => {
    const target: OverviewTarget =
      task === 'none' ? { kind: 'corpus' } : { kind: 'corpus', task: task as CorpusTask };
    expect(consolePathFor(target)).toBe(path);
    const { to } = routerTarget(path);
    if (path.startsWith('/admin/corpus')) {
      expect(modeAt(to)?.id).toBe('corpus');
      // …at a lane the route keeps (built), never the library's default.
      expect(taskLaneById(routerTarget(path).search?.lane as string)).not.toBeNull();
    } else {
      expect(usesOldShell(path)).toBe(true);
    }
  });

  it('lists every Corpus task in its table', () => {
    expect(Object.keys(CORPUS_PATHS).sort()).toEqual([...CORPUS_TASKS, 'none'].sort());
  });

  it.each([
    { kind: 'people' },
    ...PEOPLE_LISTS.map((list) => ({ kind: 'people', list }) as const),
  ] as const)('sends %o to People, which has landed', (target) => {
    const { to } = routerTarget(consolePathFor(target) as string);
    expect(modeAt(to)?.id).toBe('people');
  });

  it('opens each People list as its lane, the default as no param', () => {
    expect(consolePathFor({ kind: 'people' })).toBe('/admin/people');
    expect(consolePathFor({ kind: 'people', list: 'new' })).toBe('/admin/people?lane=newest');
    expect(consolePathFor({ kind: 'people', list: 'staff' })).toBe('/admin/people?lane=staff');
  });

  it('hands the router a path and its query apart', () => {
    expect(routerTarget('/admin/flags')).toEqual({ to: '/admin/flags' });
    expect(routerTarget('/admin/people?lane=banned')).toEqual({
      to: '/admin/people',
      search: { lane: 'banned' },
    });
  });

  it('sends the lanes to the pages that work them', () => {
    expect(consolePathFor({ kind: 'inbox' })).toBe('/admin/inbox');
    expect(consolePathFor({ kind: 'inbox', lane: 'safety' })).toBe('/admin/inbox?lane=safety');
    expect(consolePathFor({ kind: 'inbox', lane: 'contentFlags' })).toBe(
      '/admin/inbox?lane=contentFlags',
    );
    expect(consolePathFor({ kind: 'inbox', lane: 'accessReports' })).toBe(
      '/admin/inbox?lane=accessReports',
    );
    expect(consolePathFor({ kind: 'inbox', lane: 'support' })).toBe('/admin/inbox?lane=support');
    expect(consolePathFor({ kind: 'inbox', lane: 'placesAsked' })).toBe(
      '/admin/inbox?lane=placesAsked',
    );
    expect(consolePathFor({ kind: 'inbox', lane: 'requests' })).toBe('/admin/inbox?lane=requests');
    expect(consolePathFor({ kind: 'inbox', lane: 'drawnBodies' })).toBe(
      '/admin/inbox?lane=drawnBodies',
    );
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
      if (type === 'waterbody') expect(modeAt(path)?.id).toBe('corpus');
      else if (type === 'user') expect(modeAt(path)?.id).toBe('people');
      else if (type === 'importRun') expect(modeAt(routerTarget(path).to)?.id).toBe('machinery');
      else if (INBOX_TARGETS.has(type)) expect(modeAt(routerTarget(path).to)?.id).toBe('inbox');
      else expect(usesOldShell(path)).toBe(true);
    },
  );

  it('opens a body or a person on its own page, the id escaped', () => {
    expect(feedTargetPath({ type: 'waterbody', id: 'k1/7', label: 'Lake' })).toBe(
      '/admin/body/k1%2F7',
    );
    expect(feedTargetPath({ type: 'user', id: 'k1/7', label: 'Rob' })).toBe('/admin/people/k1%2F7');
  });

  it('opens a flag on its own Inbox item, and a decision on content in the Decided lane', () => {
    expect(feedTargetPath({ type: 'contentFlag', id: 'jd7flag1', label: 'x' })).toBe(
      '/admin/inbox?item=flag%3Ajd7flag1',
    );
    for (const type of ['report', 'post', 'comment', 'photo', 'hazard'] as const)
      expect(feedTargetPath({ type, id: 'jd7c1', label: 'x' })).toBe('/admin/inbox?lane=decided');
  });

  it('opens a run on its own page in Machinery › Corpus, the id escaped', () => {
    expect(feedTargetPath({ type: 'importRun', id: 'k1/7', label: 'x' })).toBe(
      '/admin/machinery/corpus?run=k1%2F7',
    );
  });

  it('opens an ask on its own Inbox item', () => {
    expect(
      feedTargetPath({ type: 'waterBodyRequest', id: 'jd7abc123', label: '“Shaker cove”' }),
    ).toBe('/admin/inbox?item=request%3Ajd7abc123');
    expect(routerTarget('/admin/inbox?item=request%3Ajd7abc123')).toEqual({
      to: '/admin/inbox',
      search: { item: 'request:jd7abc123' },
    });
  });

  it('opens nothing for a type the trail doesn’t write', () => {
    expect(feedTargetPath({ type: 'invoice', id: 'i1', label: 'Invoice' })).toBeNull();
  });
});
