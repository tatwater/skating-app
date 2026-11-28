/**
 * **A campaign already published is never rebuilt from other inputs** (B05 §2.4). A campaign names
 * its three published keys, and they are immutable — the public URL is cached for a year — so once
 * a campaign's manifest is published, what its archive was built from is fixed: core's
 * `naipBuildInputsHash` of that manifest, the one identity of a build's inputs.
 *
 * Every stage that would act on a campaign's manifest asks this first, with the published manifest
 * (or `null`, when nothing is published under the campaign):
 *
 * - **the select stage** (not a dry run), before it writes its manifest;
 * - **the tiles stage**, before it uploads that manifest over the bucket's and spawns anything;
 * - **the assembler**, before it reads a shard (`assemble.ts`), and the laptop's re-run, which
 *   compares the assembly record's `inputs` (`orchestrate.ts`' `finishedAssembly`);
 * - **verify**, which holds the published manifest, the record and the build's manifest to one value.
 *
 * The same inputs are "already done": nothing to cut, nothing to assemble. Other inputs are refused,
 * saying what differs and what to do — the change is a new campaign (`--from-current` copies what is
 * unchanged), never an overwrite and never a silent success over the earlier selection.
 */

import { type NaipManifest, naipBuildInputsDiff } from '@skating/core';
import { manifestName } from './keys';

/** A stage refusing to act on a published campaign with other inputs. Nothing was written. */
export class PublishedBuildRefusal extends Error {
  override name = 'PublishedBuildRefusal';
}

/** Lines of a difference named in one message; the rest are counted. */
const SAID = 6;

/** What differs, as one clause: `cells: 1 changed (4407236se); work tiles: 1 changed (…)`. */
export function describeDifference(diff: readonly string[]): string {
  const more = diff.length > SAID ? `; …and ${diff.length - SAID} more` : '';
  return `${diff.slice(0, SAID).join('; ')}${more}`;
}

/** How to make the change instead: a new campaign, copying the published one's unchanged tiles. */
export function newCampaignAdvice(published: Pick<NaipManifest, 'campaign' | 'pilot'>): string {
  const again =
    published.pilot === null
      ? 'naip-<YYYYMMDD>'
      : `naip-pilot-<YYYYMMDD> --pilot ${published.pilot}`;
  return `make the change a new campaign: run-aerial.sh ${again} --from-current, with NAIP_MANIFEST_URL at ${manifestName(published.campaign)}, copies its unchanged work tiles`;
}

/**
 * The refusal for acting on `next` under a campaign already published from `published`, or `null`
 * when the two name the same inputs.
 */
export function publishedConflict(published: NaipManifest, next: NaipManifest): string | null {
  const diff = naipBuildInputsDiff(published, next);
  if (diff.length === 0) return null;
  return `${published.campaign} is already published from other inputs (${describeDifference(diff)}). A published key is never overwritten, so ${published.campaign} stays as it was built — ${newCampaignAdvice(published)}`;
}

/**
 * Where `next` stands against what its campaign has published: `'unpublished'` (nothing is), or
 * `'published'` (it is, from these same inputs: nothing to do). Throws a
 * {@link PublishedBuildRefusal} when it is published from other inputs.
 */
export function againstPublished(
  published: NaipManifest | null,
  next: NaipManifest,
): 'unpublished' | 'published' {
  if (published === null) return 'unpublished';
  const conflict = publishedConflict(published, next);
  if (conflict !== null) throw new PublishedBuildRefusal(conflict);
  return 'published';
}
