import { describe, expect, it } from 'vitest';
import { readState } from '@/components/admin/reads/consoleReads';
import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
import { namesFromBody } from './names/namesModel';
import { placesFrom } from './places/placesModel';
import { waterFrom } from './water/waterModel';

/**
 * **Every secondary read on the Body console's tabs keeps its four answers apart**: on its way is
 * drawn as on its way, a failure is in the tab's failure note (with Try again), and *not recorded*
 * comes only from a settled nothing. One row per read beside a tab's main read; each row says what
 * the tab's data holds for the read failed, loading and settled empty.
 */

const WATER_BODY = {
  name: 'Mascoma Lake',
  states: ['NH'],
  meanDepthM: 9.4,
  meanDepthSource: 'state_agency' as const,
  interiorPoint: { lat: 43.6, lng: -72.1 },
};
const EXTRAS = { hasBathymetry: false, bathymetrySearched: null };
const NO_CHOICES = { mean: { choices: [] }, max: { choices: [] }, recorded: false };
const NAMES_BODY = { name: 'Mascoma Lake', type: 'reservoir' as const, states: ['NH'] };
const PLACES = { towns: ['Enfield'], counties: ['Grafton'], states: ['NH'], computedAt: 1 };
const PLACES_READS = {
  landmarks: [],
  bays: [],
  names: { names: [], more: false },
  proposals: { proposals: [], more: false },
  provenance: [],
  proposers: 'hidden' as const,
};

type Answer = { failed: boolean; notRecorded: boolean; loading: boolean };
type Row = {
  read: string;
  /** What the tab's data says about the read in each state. */
  answer: (state: 'failed' | 'loading' | 'none') => Answer;
};

const ROWS: Row[] = [
  {
    read: 'Water: the other sources’ depths (`depthChoices`)',
    answer: (state) => {
      const read = state === 'failed' ? FAILED_READ : state === 'loading' ? undefined : NO_CHOICES;
      const d = waterFrom(
        WATER_BODY as never,
        EXTRAS,
        readState(read as never, (c: { recorded: boolean }) => !c.recorded) as never,
      );
      return {
        failed: d.failures.includes('the other sources’ depths') && d.depth.others === 'failed',
        notRecorded: d.depth.others === null,
        loading: d.depth.others === 'loading',
      };
    },
  },
  {
    read: 'Water: the bathymetry state (`consoleExtras`)',
    answer: (state) => {
      const read = state === 'failed' ? FAILED_READ : state === 'loading' ? undefined : EXTRAS;
      const d = waterFrom(WATER_BODY as never, read as never);
      return {
        failed: d.failures.includes('the bathymetry state'),
        notRecorded:
          typeof d.bathymetry === 'object' &&
          d.bathymetry !== null &&
          'searched' in d.bathymetry &&
          d.bathymetry.searched === null,
        loading: d.bathymetry === undefined,
      };
    },
  },
  {
    read: 'Names: the moderator’s aliases and class (`identity`)',
    answer: (state) => {
      const identity =
        state === 'failed'
          ? FAILED_READ
          : state === 'loading'
            ? undefined
            : {
                bodyClass: 'reservoir',
                classClaims: null,
                moderatorClass: null,
                moderatorAliases: [],
              };
      const d = namesFromBody(NAMES_BODY, PLACES, { identity: identity as never });
      return {
        failed: d.failures.includes('the moderator’s aliases and class'),
        notRecorded: state === 'none' && d.classOptions === null,
        loading: !d.aliasesEditable && !d.failures.includes('the moderator’s aliases and class'),
      };
    },
  },
  {
    read: 'Names: the town lines (`townLines`)',
    answer: (state) => {
      const read = state === 'failed' ? FAILED_READ : state === 'loading' ? undefined : null;
      const d = namesFromBody(NAMES_BODY, PLACES, { townLinesRead: read as never });
      return {
        failed: d.failures.includes('the town lines'),
        notRecorded: state === 'none' && d.place.townLines?.length === 0,
        loading: d.place.townLines === null,
      };
    },
  },
  {
    read: 'Places: when each landmark was added (`landmarkProvenance`)',
    answer: (state) => {
      const read = state === 'failed' ? FAILED_READ : state === 'loading' ? undefined : [];
      const d = placesFrom({ ...PLACES_READS, provenance: read as never });
      return {
        failed: d.failures.includes('when each landmark was added'),
        notRecorded: state === 'none' && !d.failures.includes('when each landmark was added'),
        loading: state === 'loading' && d.failures.length === 0,
      };
    },
  },
];

describe('a secondary read’s four answers are never folded', () => {
  it.each(ROWS)('$read', (row) => {
    const failed = row.answer('failed');
    expect(failed.failed).toBe(true);
    expect(failed.notRecorded).toBe(false);
    const loading = row.answer('loading');
    expect(loading.loading).toBe(true);
    expect(loading.failed).toBe(false);
    expect(loading.notRecorded).toBe(false);
    const none = row.answer('none');
    expect(none.failed).toBe(false);
    expect(none.loading).toBe(false);
    // Not recorded comes from a settled nothing — and from it, it does come.
    expect(none.notRecorded).toBe(true);
  });

  it('readState keeps them apart: on its way, failed, settled with nothing, a value', () => {
    expect(readState(undefined)).toEqual({ kind: 'loading' });
    expect(readState(FAILED_READ)).toMatchObject({ kind: 'failed' });
    expect(readState(null)).toEqual({ kind: 'none' });
    expect(readState({ recorded: false }, (v) => !v.recorded)).toEqual({ kind: 'none' });
    expect(readState(3)).toEqual({ kind: 'value', value: 3 });
  });
});
