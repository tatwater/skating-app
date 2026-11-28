import { shortAge } from '@/lib/ages';

import type { AttemptVerdict, AttemptView, CronState, GranuleStatus } from './imageryModel';

/**
 * **Every word Machinery › Imagery says** — the boards' own (6.4, *Waiting for Cold*, *Line
 * Crossed*) and every word no board supplied, in one module for the founder's copy pass. Relaxed and
 * human: a person telling another what the pipeline is doing.
 *
 * Two places the boards are wrong, drawn as the pipeline is: **an empty cut is never about cloud**
 * (the cutter cuts every pass whatever its cloud; the row reads the marker's own reason), and **the
 * poll has no in-run retry**.
 *
 * Machine-minutes only, never dollars (ruling 6). Nothing here says or implies anything about the
 * ice (D3): the lines are the watch's air temperatures at named sites, and imagery is a camera.
 */

// ── The sidebar ─────────────────────────────────────────────────────────────────────────────────

/** The lane's name, and the page word. */
export const IMAGERY = 'Imagery';
/** Where the imagery pipeline runs: on Convex (its cuts on Fly). */
export const CONVEX_TAG = 'Convex';

/** The lane's tail, by what the season or its crons say. */
export function imageryTailWords(
  tail:
    | { state: 'notStarted'; ready: boolean }
    | { state: 'paused' | 'ended' | 'noWatch' }
    | { state: CronState; lastTickAt: number | null },
  now: number,
): { word: string; tone: 'default' | 'lit' | 'warn' | 'bad' } {
  switch (tail.state) {
    case 'notStarted':
      // A crossed line waits on a person to start it.
      return { word: 'not started', tone: 'ready' in tail && tail.ready ? 'warn' : 'default' };
    case 'noWatch':
      return { word: 'not started', tone: 'default' };
    case 'paused':
      return { word: 'paused', tone: 'warn' };
    case 'ended':
      return { word: 'ended', tone: 'default' };
    case 'stalled':
      return { word: 'stalled', tone: 'bad' };
    case 'failed':
      return { word: 'failed', tone: 'bad' };
    case 'late':
      return { word: 'late', tone: 'warn' };
    case 'never':
      return { word: NOT_RECORDED_YET_TAIL, tone: 'default' };
    case 'running':
      return { word: 'running', tone: 'lit' };
    default: {
      const at = 'lastTickAt' in tail ? tail.lastTickAt : null;
      return { word: at === null ? 'ok' : `ok ${shortAge(now - at)}`, tone: 'default' };
    }
  }
}

/**
 * **A cron with no recorded tick** (Ma28): the page's word for core's `never`, on the lane's tail
 * (lowercase, as every tail) and wherever a cron is drawn.
 */
export const NOT_RECORDED_YET = 'Not recorded yet';
export const NOT_RECORDED_YET_TAIL = 'not recorded yet';

// ── The head ────────────────────────────────────────────────────────────────────────────────────

export const headKicker = (season: string) =>
  `${season} · polled and pumped on Convex · cut on Fly`;
export const SEASONS_LINK = 'Seasons';

export const STATE = 'State';
export const STATE_WORDS = {
  running: 'Running',
  paused: 'Paused',
  ended: 'Ended',
  notStarted: 'Not started',
  noWatch: 'Not started',
} as const;
export const startedBy = (name: string, day: string) => `Started by ${name} ${day}`;
export const startedOn = (day: string) => `Started ${day}`;
export const cutterPinned = (day: string) => `cutter pinned ${day}`;
export const PAUSED_SUB = 'No new cuts start until someone resumes it';
export const ENDED_SUB = 'The watch ended, and imagery stood down with it';
export const NOT_STARTED_SUB = 'Nothing is cut until someone starts it';
export const NO_WATCH_SUB = 'There’s no ice watch this season yet';

export const LANDED = 'Granules landed';
export const ofQueued = (n: number) => `Of ${n.toLocaleString('en-US')} queued since the start`;

export const MACHINES = 'Machines';
export const LIVE = 'live';
export const CUTTING_NOW = 'Cutting now';
export const NONE_CUTTING = 'None cutting right now';
export const NOT_LISTED_YET = 'Not counted yet';

export const LIVE_INDEX = 'Live index';
export const NOT_BUILT = 'Not built';
export const BUILDS_ONCE = 'Builds once a frame lands';
export const FRAMES = 'frames';
export const REBUILT_AS_FRAMES_LAND = 'Rebuilt as frames land';
export const rereadsAt = (time: string) =>
  `A few frames didn’t read; it tries them again at ${time}`;
export const REREADS_NEXT = 'A few frames didn’t read; it tries them again on its next run';

export const FLY = 'Fly · this season';
export const MACHINE_MIN = 'machine-min';
export const countedFrom = (day: string) => `Counted from ${day}`;
export const SINCE_THE_START = 'Since the start';

export const backingOffUntil = (time: string) =>
  `Fly or the bucket was failing, so the pump is waiting until ${time}`;
export const UNCONFIGURED =
  'Fly and R2 aren’t set up on this deployment, so nothing can be cut until they are.';

// ── The waiting head ────────────────────────────────────────────────────────────────────────────

export const ICE_WATCH = 'Ice watch';
export const OPEN = 'Open';
export const NOT_OPEN = 'Not open';
export const openSince = (day: string) => `Since ${day}`;
export const sentinelsOf = (fired: number, of: number) => `${fired} of ${of} sentinels`;
export const OPENS_ON_COLD = 'Opens on the first cold night at the sentinels';
export const CLOSEST_NIGHT = 'Closest night';
export const NO_NIGHT_YET = 'No sentinel night yet';
export const IMAGERY_LINE = 'Imagery line';
export const CROSSED = 'Crossed';
export const ANY_ONE_SENTINEL = 'Any one sentinel, one night';
export const STAFF_EMAIL = 'Staff email';
export const NOT_SENT_YET = 'Not sent yet';
export const SENT_TO_STAFF = 'to staff';
export const THEN_NOT_SENT_SHORT = 'It goes out with the next daily check';
export const TODAY = 'Today';
export const YESTERDAY = 'Yesterday';
export const degreesF = (f: string) => `${f} °F`;
export const DEGREES_F = '°F';

// ── The waiting body ────────────────────────────────────────────────────────────────────────────

export const HOW_CLOSE = 'How close each sentinel has come';
export const AGAINST_THE_LINE = 'Each sentinel against the line';
export const observedSince = (day: string) => `Observed lows · since ${day}`;
export const OBSERVED_LOWS = 'Observed lows';
export const SENTINEL = 'Sentinel';
export const LAST_NIGHT = 'Last night';
export const COLDEST = 'Coldest';
export const nightsAtOrBelow = (f: string) => `Nights ≤ ${f} °F`;
export const SHORT_OF_LINE = 'Short of the line';
export const AGAINST_LINE = 'Against the line';
export const nightsOf = (n: number, of: number) => `${n} of ${of}`;
export const shortBy = (f: string) => `${f} °F short`;
export const belowBy = (f: string) => `${f} °F below`;
export const NO_LOWS = 'No lows recorded yet';

export const WAITING_FOR = 'What it’s waiting for';
export const WHAT_HAPPENED = 'What happened';
export const THE_LINE = 'The line';
export const THEN = 'Then';
export const THRESHOLDS = 'Thresholds';
export const lineRule = (f: string) =>
  `The first night any one sentinel’s low reaches ${f} °F. One night is enough; it doesn’t have to hold. A night counts once it’s observed, never from a forecast.`;
export const lineCrossedOn = (day: string, sites: string) =>
  `Crossed on ${day}: ${sites}. One night is enough.`;
export const lineCrossedOnDay = (day: string) => `Crossed on ${day}. One night is enough.`;
export const THEN_WAITING =
  'Every staff member gets “Time to start satellite imagery,” on the first day the watch hasn’t already sent one. Nothing starts on its own.';
export const thenSent = (when: string) =>
  `Every staff member got “Time to start satellite imagery” ${when}. Nothing starts on its own.`;
export const THEN_NOT_SENT =
  'Every staff member gets “Time to start satellite imagery” with the next daily check. Nothing starts on its own.';
export const THRESHOLDS_BODY =
  'The line and the watch’s other triggers stay as they are until they’re changed in Seasons.';

// ── The start panel ─────────────────────────────────────────────────────────────────────────────

export const START_TITLE = 'Start imagery';
export const READY_TO_START = 'Ready to start';
export const OFF = 'Off';
export const START_WAITING =
  'You can start it any time the watch is open. Until a sentinel reaches the line, staff aren’t asked to.';
export const startCrossed = (day: string) =>
  `A sentinel crossed the line on ${day}. Nothing is cut until you start it.`;
export const START_NO_WATCH =
  'The ice watch hasn’t opened this season, so there’s nothing to look for yet.';
export const START_UNCONFIGURED =
  'Fly and R2 aren’t set up on this deployment. Start it once they are.';
export const WHAT_STARTING_DOES = 'What starting does, in order';
export const STARTING_STEPS: readonly { head: string; body: string }[] = [
  {
    head: 'Checks the catalogs right away',
    body: 'Asks Sentinel-1 and Sentinel-2 for every pass over the watched lakes since the watch opened.',
  },
  {
    head: 'Checks again every 6 hours',
    body: 'Until the watch ends. A pass that’s already queued is never queued twice.',
  },
  {
    head: 'Cuts each pass on Fly',
    body: 'One machine a pass, up to 25 at once. A pass that misses every lake is marked empty.',
  },
  {
    head: 'Rebuilds the live index',
    body: 'As frames land, so the map’s imagery layer has them.',
  },
];
export const WHAT_IT_COSTS = 'What it costs';
export const COST_FLY = 'Fly';
export const COST_FLY_BODY = 'Metered here in machine-minutes as it runs.';
export const COST_CATALOGS = 'Catalogs';
export const COST_CATALOGS_BODY =
  'Free. Two catalog searches and two reads from the bucket every 6 hours.';
export const COST_STOPPING = 'Stopping';
export const COST_STOPPING_BODY =
  'Pause stops new cuts at once; cuts already running finish. It stands down on its own when the watch ends.';

// ── The granule list ────────────────────────────────────────────────────────────────────────────

export const FILTER_WORDS = {
  all: 'All',
  queued: 'Queued',
  cutting: 'Cutting',
  empty: 'Empty',
  failed: 'Failed',
} as const;
export const LIST_LABEL = 'Granules';
export const FILTER_LABEL = 'Show';
export const EVERYTHING_ELSE = 'Everything else · newest first';
export const STATUS_WORDS: Record<GranuleStatus, string> = {
  queued: 'queued',
  spawned: 'cutting',
  landed: 'landed',
  empty: 'empty',
  failed: 'failed',
};
export const attemptsWords = (n: number) => `${n} ${n === 1 ? 'attempt' : 'attempts'}`;
export const captured = (when: string) => `Captured ${when}`;
export const machineUp = (age: string) => `machine up ${age}`;
export const WAITING_FOR_MACHINE = 'waiting for a machine';
export const nothingToCut = (reason: string | null) =>
  reason === null ? 'Nothing to cut · the reason wasn’t recorded' : `Nothing to cut · ${reason}`;
export const FRAME_LANDED = 'frame landed';
export const allGranules = (n: number) => `All ${n.toLocaleString('en-US')}`;
export const NO_GRANULES = 'No granules yet';
export const NONE_IN_FILTER = {
  all: 'No granules yet',
  queued: 'Nothing queued',
  cutting: 'Nothing cutting',
  empty: 'No empty cuts',
  failed: 'Nothing failed',
} as const;
export const LIST_FAILED = 'The granules didn’t load.';
export const REST_FAILED = 'The rest of the granules didn’t load.';
export const FAILED_FIRST_FAILED = 'The failed granules didn’t load.';
export const LOADING_MORE = 'Loading more';
export const failedShownOf = (n: number) =>
  `The newest ${n.toLocaleString('en-US')} failed are shown here; Failed lists them all.`;

// ── The granule detail ──────────────────────────────────────────────────────────────────────────

export const DETAIL_LABEL = 'Granule';
export const BACK_TO_LIST = 'Back to the list';
export const NOTHING_OPEN = 'No granule open';
export const NOTHING_OPEN_HINT = 'Choose a granule to see its attempts and its log.';
export const GRANULE_MISSING =
  'That granule isn’t here. It may have been cleared, or the link is wrong.';
export const GRANULE_FAILED = 'The granule didn’t load.';
export const NOT_RECORDED = 'Not recorded';

export const badgeWords = (status: GranuleStatus, attempts: number) =>
  status === 'failed'
    ? `Failed · ${attemptsWords(attempts)}`
    : status === 'spawned'
      ? 'Cutting'
      : status.charAt(0).toUpperCase() + status.slice(1);

export const CAPTURED = 'Captured';
export const IN_THE_CATALOG = 'In the catalog';
export const afterThePass = (day: string, gap: string) => `${day} · ${gap} after the pass`;
export const QUEUED = 'Queued';
export const byThePoll = (day: string) => `${day} · by the poll`;
export const EXIT = 'Exit';
export const OUT_OF_MEMORY = 'Killed: out of memory';
export const exitedWithError = 'The cutter stopped with an error';
export const NO_EXIT = 'Fly didn’t say';
export const LANDED_AT = 'Landed';
export const SETTLED_AT = 'Settled';
export const MACHINE_UP = 'Machine up';
export const WAITING = 'Waiting';
export const sinceQueued = 'Since it was queued';

export const ATTEMPTS = 'Attempts';
export const ATTEMPT = 'Attempt';
export const MACHINE = 'Machine';
export const STARTED = 'Started';
export const TOOK = 'Took';
export const OUTCOME = 'Outcome';
export const about = (took: string) => `about ${took}`;
export const VERDICT_WORDS: Record<
  AttemptVerdict,
  { words: string; tone: 'bad' | 'warn' | 'lit' | 'fg' }
> = {
  cutting: { words: 'cutting', tone: 'lit' },
  landed: { words: 'landed', tone: 'fg' },
  empty: { words: 'nothing to cut', tone: 'fg' },
  requeued: { words: 'back in the queue', tone: 'warn' },
  failed: { words: 'failed · attempts spent', tone: 'bad' },
  refused: { words: 'Fly turned it down', tone: 'warn' },
  unconfirmed: { words: 'never confirmed', tone: 'warn' },
};
export const attemptsBefore = (day: string | null) =>
  day === null
    ? 'Attempts from before this page existed weren’t recorded.'
    : `Attempts before ${day} weren’t recorded.`;
export const keptCount = (n: number, error: string | null) =>
  error === null
    ? `This granule kept its count (${n}).`
    : `This granule kept its count (${n}) and its last error: ${error}.`;
export const NO_ATTEMPTS_YET = 'No machine has picked it up yet.';

export const MACHINE_LOG = 'Machine log';
export const logOrigins = (attempt: number, from: string) => `Attempt ${attempt} · ${from}`;
export const ORIGIN_WORDS = { cutter: 'cutter', fly: 'Fly', pump: 'pump' } as const;
/** Who wrote an attempt's log, from its record: the cutter's upload (kept) and Fly's word on a miss. */
export function logFrom(log: 'pending' | 'kept' | 'none' | 'missing', landed: boolean): string {
  if (log === 'kept') return landed ? 'from the cutter' : 'from the cutter and Fly';
  return 'from Fly';
}
export const attemptNumber = (attempt: number) => `Attempt ${attempt}`;
export const SHOW_LOG = 'Show the log';
export const LOG_PENDING = 'The pump hasn’t collected this log yet. It shows up here once it has.';
export const LOG_CUTTING = 'The log shows up once this cut settles.';
export const LOG_NONE =
  'This cutter didn’t keep a log of its own: it ran on an image from before logs were kept.';
export const LOG_MISSING = 'The pump couldn’t collect the cutter’s log for this attempt.';
export const LOG_EMPTY = 'No lines were kept.';
export const LOG_LOADING = 'Loading the log';
export const LOG_FAILED = 'The log didn’t load.';
export const SCROLL_UP = 'Scroll up for the full log';
export const LOADING_OLDER = 'Loading older lines';

export const WHAT_TO_CHECK = 'What to check';
export function whatToCheck(
  attempts: readonly AttemptView[],
  refusals: number,
): {
  label: string;
  body: string;
}[] {
  const rows: { label: string; body: string }[] = [];
  const last = attempts.reduce<AttemptView | null>(
    (n, a) => (n === null || a.attempt > n.attempt ? a : n),
    null,
  );
  if (last !== null && last.exitCode !== null && last.oomKilled === true) {
    const every = attempts.length > 1 && attempts.every((a) => a.oomKilled === true);
    rows.push({
      label: `Exit ${last.exitCode}`,
      body: every
        ? 'The Machine ran out of memory, and every attempt died the same way, so another try on the same size will likely die there too.'
        : 'The Machine ran out of memory. Radar scenes are the larger ones.',
    });
    rows.push({
      label: 'Machine size',
      body: 'Set in the cutter’s config, not here. Retry once it changes.',
    });
  } else if (last !== null && last.exitCode !== null && last.exitCode !== 0) {
    rows.push({
      label: `Exit ${last.exitCode}`,
      body: 'The cutter stopped with an error. The log above shows the step it was on.',
    });
  }
  if (refusals >= 3 || (attempts.length > 0 && attempts.every((a) => a.verdict === 'refused'))) {
    rows.push({
      label: 'Spawn refused',
      body: 'Fly turned it down three times. Check that FLY_IMAGE names an image that exists, and that the deploy token is still good.',
    });
  }
  if (last !== null && last.verdict === 'unconfirmed') {
    rows.push({
      label: 'Never confirmed',
      body: 'Fly never said the Machine started, so it may not have been made. A retry sends a new one.',
    });
  }
  if (last !== null && last.log === 'none') {
    rows.push({
      label: 'No cutter log',
      body: 'This cut ran on a cutter image from before logs were kept. Logs start with the next image.',
    });
  }
  return rows;
}

// ── The action bar and its toasts ───────────────────────────────────────────────────────────────

export const BAR = 'This season';
export const retryFailedLabel = (n: number) => `Retry failed · ${n.toLocaleString('en-US')}`;
export const RETRY_FAILED_WHAT = 'Puts every failed granule back in line with fresh attempts.';
export const PAUSE = 'Pause';
export const PAUSE_WHAT = 'Stops new cuts at once. Cuts already running finish.';
export const RESUME = 'Resume';
export const RESUME_WHAT = 'Starts cutting again where it left off.';
export const TRY_AGAIN_NOW = 'Try again now';
export const TRY_AGAIN_WHAT = 'Stops waiting out the last failure and goes again now.';
export const RUN_NOW = 'Run now';
export const RUN_NOW_WHAT = 'Asks both catalogs now. A pass already queued is never queued twice.';

export const STARTED_TOAST = 'Imagery started';
export const STARTED_LINE = 'The catalogs are checked right away, then every 6 hours.';
export const NOT_STARTED_TOAST = 'Imagery not started';
export const PAUSED_TOAST = 'Imagery paused';
export const PAUSED_LINE = 'No new cuts start. Cuts already running finish.';
export const NOT_PAUSED_TOAST = 'Imagery not paused';
export const RESUMED_TOAST = 'Imagery resumed';
export const NOT_RESUMED_TOAST = 'Imagery not resumed';
export const POLLED_TOAST = 'Checking the catalogs now';
export const POLLED_LINE = 'New passes show up in the list as they’re queued.';
export const NOT_POLLED_TOAST = 'Catalogs not checked';
export const retriedToast = (n: number) =>
  n === 1
    ? '1 failed cut is back in line'
    : `${n.toLocaleString('en-US')} failed cuts are back in line`;
export const RETRIED_LINE = 'Each gets fresh attempts on the pump’s next run.';
export const NOT_RETRIED_TOAST = 'Failed cuts not retried';
export const TRIED_AGAIN_TOAST = 'Trying again now';
export const TRIED_AGAIN_LINE = 'The pump and the index go again now instead of waiting.';
export const NOT_TRIED_AGAIN_TOAST = 'Not tried again';

// ── The page's reads ────────────────────────────────────────────────────────────────────────────

export const PAGE_FAILED = 'The imagery page didn’t load.';
export const NO_SEASON = 'No imagery season yet';
export const NO_SEASON_HINT = 'The page fills in once the season watch has a season to look at.';

/** A short age, for a row's corner. */
export const ageWords = (ms: number) => shortAge(ms);
