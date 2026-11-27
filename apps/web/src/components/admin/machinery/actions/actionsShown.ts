import type { LivenessView, RunStatus } from '../corpus/runViews';

/**
 * **Whether *Stop* is drawn — the one switch.** The server builds the request to stop and its
 * withdrawal (`machineryWrites.requestRunStop` / `withdrawRunStop`), and the run logger honors it;
 * the founder ruled it built and hidden while the campaign runs on his laptop, where Ctrl-C in the
 * terminal is in reach and quicker. Flipping this to `true` draws *Stop* on every running run's
 * action bar (from its first beat, not only once late), with its receipt and undo already wired.
 * Nothing else in the console draws a stop.
 */
export const STOP_DRAWN = false;

/** What a run's action bar holds. */
export type RunActionsShown = {
  /** The bar is drawn at all. */
  bar: boolean;
  markFailed: boolean;
  /** *Mark the campaign failed too*, after its pass was marked. */
  campaignToo: boolean;
  wait: boolean;
  stop: boolean;
};

/**
 * Which actions a run offers, by its state at the page's clock:
 *
 * - **The bar appears once a running run is late** — late, stalled, held by a wait, or with no
 *   heartbeat recorded at all (a row from before heartbeats, left running by a killed loader).
 *   An on-time run, a finished one and a run already marked draw no bar.
 * - ***Mark failed*** on every such run.
 * - ***Wait 30 minutes*** only while stalled and not already held.
 * - ***Stop*** only when the switch above is on, on any running run not already asked.
 * - ***Mark the campaign failed too*** whenever the server says its offer holds (`campaignToo`,
 *   core's `offersCampaignMark`: the campaign still open, its newest pass the one marked, nothing
 *   after the mark), on the campaign's page and on that pass's own. Not a clock reading: the read
 *   moves when a later pass opens, the campaign closes, or a mark is undone. While it shows, the
 *   campaign's own *Mark failed* is not drawn beside it: both would send the same mark.
 */
export function runActions(
  run: {
    status: RunStatus;
    liveness: LivenessView;
    marked: boolean;
    stopAsked?: boolean;
    campaignToo?: boolean;
  },
  { stopDrawn = STOP_DRAWN }: { stopDrawn?: boolean } = {},
): RunActionsShown {
  const running = run.status === 'running' && !run.marked;
  const state = run.liveness.state;
  const quiet =
    running &&
    (state === 'late' || state === 'stalled' || state === 'waiting' || state === 'notRecorded');
  const stop = stopDrawn && running && state !== 'finished' && run.stopAsked !== true;
  const campaignToo = run.campaignToo === true;
  return {
    bar: quiet || stop || campaignToo,
    markFailed: quiet && !campaignToo,
    campaignToo,
    wait: quiet && state === 'stalled',
    stop,
  };
}
