import { ID_SHAPE } from '../reads/readArgs';

/**
 * **Machinery › Corpus's place in the URL**, validated, never trusted (the route's `validateSearch`):
 *
 * - **`campaign`**: a campaign id, as `run-corpus.sh` names one and prints in its URL
 *   (`a07a-20261012`, `machinery-check`) — letters, digits, `.`, `_` and `-`, at most
 *   {@link CAMPAIGN_MAX_CHARS}. Opens that campaign's page.
 * - **`run`**: an `importRuns` id. Opens that run — a pass's page, or a campaign's when the run is a
 *   campaign row (an audit feed row on a marked campaign links by its id).
 *
 * Anything else is dropped, and so is a value of the wrong shape. Both may stand together: a pass
 * opened from its campaign keeps the campaign, so its way back is the campaign's page.
 */

/** The longest campaign id the URL holds. */
export const CAMPAIGN_MAX_CHARS = 80;

const CAMPAIGN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What the page's search holds, every default left out. */
export type MachinerySearch = { campaign?: string; run?: string };

/** A campaign id `raw` names, or `null`. */
export function campaignOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text.length <= CAMPAIGN_MAX_CHARS && CAMPAIGN_SHAPE.test(text) ? text : null;
}

/** An `importRuns` id `raw` names, or `null`. */
export function runOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return ID_SHAPE.test(text) ? text : null;
}

/** The route's `validateSearch`. */
export function validateMachinerySearch(raw: Record<string, unknown>): MachinerySearch {
  const campaign = campaignOf(raw.campaign);
  const run = runOf(raw.run);
  return { ...(campaign !== null && { campaign }), ...(run !== null && { run }) };
}

/** Where the page is, as it reads it. */
export interface MachineryPlace {
  campaign: string | null;
  run: string | null;
}

export function placeOf(search: MachinerySearch): MachineryPlace {
  return { campaign: campaignOf(search.campaign), run: runOf(search.run) };
}

/** The search that puts the page at `place`: absent fields left out, so equal places are equal URLs. */
export function searchOf(place: MachineryPlace): MachinerySearch {
  return {
    ...(place.campaign !== null && { campaign: place.campaign }),
    ...(place.run !== null && { run: place.run }),
  };
}

/** Whether anything is open. */
export const isOpen = (place: MachineryPlace): boolean =>
  place.campaign !== null || place.run !== null;
