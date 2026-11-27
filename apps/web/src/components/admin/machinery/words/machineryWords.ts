import { shortAge } from '@/lib/ages';

/**
 * **Every word Machinery's frame says that no board supplied** — the sidebar, the run list, Inbox
 * Zero's line — in one module for the copy pass. The boards' own words (*Corpus*, *Runs · newest
 * first*, the chips) are here too, so the frame reads one place. The run pages' words are W2's
 * (`runWords.ts`), so the two modules never share an edit.
 *
 * Nothing here says or implies anything about the ice (D3): a run is the pipeline at work, never a
 * claim about conditions.
 */

// ── The sidebar ─────────────────────────────────────────────────────────────────────────────────

/** The navigation's name (the kit `Lanes`' label). */
export const LANES_LABEL = 'Machinery';
/** The one group 8a draws. */
export const PIPELINES_GROUP = 'Pipelines';
/** The Corpus lane, and the list's page word. */
export const CORPUS = 'Corpus';
/** Where the corpus pipeline runs: the laptop, not Convex. */
export const LOCAL_TAG = 'Local';
/** The lanes' read failed: said at the sidebar's foot. */
export const LANES_FAILED = 'The pipelines’ state couldn’t be read';

// ── The run list ────────────────────────────────────────────────────────────────────────────────

/** The kicker beside the page word. */
export const LIST_KICKER = 'Runs · newest first';
/** The list's accessible name. */
export const LIST_LABEL = 'Corpus runs';
/** The detail column's accessible name. */
export const DETAIL_LABEL = 'Run';
export const BACK_TO_LIST = 'Back to the list';

/** The kind chip. */
export const KIND_WORDS = { campaign: 'campaign', pass: 'single pass' } as const;

/** A row's state chip, by what the row says. */
export const STATE_WORDS = {
  stalled: 'stalled',
  late: 'late',
  waiting: 'waiting',
  running: 'running',
  notRecorded: 'no heartbeat',
  failed: 'failed',
  succeeded: 'succeeded',
  applied: 'applied',
  dryRun: 'dry run',
  unknown: 'not recorded',
} as const;

/** A fact no row carries (a field written before this record existed). */
export const NOT_RECORDED = 'Not recorded';
/** A campaign row the server rebuilt from its runs (no record of its own was kept at the time). */
export const REBUILT = 'Rebuilt from its runs';

/** "2 of 10 passes", or "2 passes" when the plan wasn't recorded. */
export function passesWords(done: number, planned: number | null): string {
  return planned === null
    ? `${done.toLocaleString('en-US')} ${done === 1 ? 'pass' : 'passes'}`
    : `${done.toLocaleString('en-US')} of ${planned.toLocaleString('en-US')} passes`;
}

/** "25,050 bodies loaded". */
export const bodiesLoaded = (n: number) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? 'body' : 'bodies'} loaded`;

/** "Stopped at load-sub-areas". */
export const stoppedAt = (pass: string) => `Stopped at ${pass}`;

/** A pass's headline count: "237 place names queued", from the server's count name. */
export function headlineWords(name: string, value: number): string {
  return `${value.toLocaleString('en-US')} ${countName(name)}`;
}

/** A stored count's name in words: `placeNamesQueued` / `place_names_queued` → "place names queued". */
export function countName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The scope a run was asked: "Full canonical", "Full canonical · VT", "One state · VT". */
export function scopeWords(scope: {
  pass: string;
  states: readonly string[] | null;
  complete: boolean;
}): string {
  const word = countName(scope.pass);
  const name = word === '' ? NOT_RECORDED : word.charAt(0).toUpperCase() + word.slice(1);
  return scope.states !== null && !scope.complete && scope.states.length > 0
    ? `${name} · ${scope.states.join(', ')}`
    : name;
}

/** The list's end tab once every row is in. */
export const allRuns = (n: number) => `All ${n.toLocaleString('en-US')}`;
/** …before the history is indexed: what's listed is only the newest runs. */
export const listedSoFar = (n: number) => `${n.toLocaleString('en-US')} listed so far`;
/** An empty list, history indexed. */
export const NO_RUNS = 'No runs yet';
/** An empty list before the history is indexed: never read as an empty history. */
export const NONE_LISTED_YET = 'None listed yet';
/** Over the list until the history is indexed. */
export const NOT_INDEXED = 'Older runs appear once they’re indexed.';
export const LIST_FAILED = 'The runs didn’t load.';
export const REST_FAILED = 'The rest of the runs didn’t load.';
export const LOADING_MORE = 'Loading more';

// ── The detail column, before a run opens ───────────────────────────────────────────────────────

export const NOTHING_OPEN = 'No run open';
export const NOTHING_OPEN_HINT = 'Choose a run to see its passes and its log.';
export const RUN_MISSING = 'That run isn’t here. It may have been removed, or the link is wrong.';
export const RUN_FAILED = 'The run didn’t load.';

// ── The sidebar's tail and Inbox Zero's line ────────────────────────────────────────────────────

/** The lane's tail word, by its state; `ok` carries how long ago ("ok 2 min"). */
export function laneTailWords(
  state: string,
  at: number | null,
  now: number,
): { word: string; tone: 'default' | 'lit' | 'warn' | 'bad' } {
  switch (state) {
    case 'stalled':
      return { word: 'stalled', tone: 'bad' };
    case 'failed':
      return { word: 'failed', tone: 'bad' };
    case 'late':
      return { word: 'late', tone: 'warn' };
    case 'waiting':
      return { word: 'waiting', tone: 'warn' };
    case 'notRecorded':
      return { word: 'no heartbeat', tone: 'warn' };
    case 'running':
      return { word: 'running', tone: 'lit' };
    case 'never':
      return { word: 'not run', tone: 'default' };
    default:
      return { word: at === null ? 'ok' : `ok ${shortAge(now - at)}`, tone: 'default' };
  }
}

/** Inbox Zero's *Machinery* line: only what needs a person; nothing when all is quiet. */
export function zeroLine(state: string): string | null {
  switch (state) {
    case 'stalled':
      return '1 run stalled';
    case 'waiting':
      return '1 run stalled, waited on';
    case 'late':
      return '1 run late';
    case 'failed':
      return 'The last run failed';
    case 'notRecorded':
      return '1 run with no heartbeat';
    default:
      return null;
  }
}
