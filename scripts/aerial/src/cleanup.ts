/**
 * **Cleanup** (B05 §2.5): `run-aerial.sh <campaign> --stage cleanup --old <key>` deletes a
 * superseded archive — its archive, date index and manifest — and that old build's private build
 * prefix (its shards, indexes and records), and nothing else.
 *
 * Its refusals, every one checked before anything is deleted:
 *
 * - **never the newest archive** under its prefix (a production key among the production keys, a
 *   pilot's among its pilot's): the newest is the one being served or about to be;
 * - **never the archive the web points at** (`VITE_NAIP_PMTILES_URL` in the local web checkout, read
 *   by name and compared, never printed): the local env is the operator's record of what is live —
 *   and when it can't be read, nothing is deleted, since what is live can't be told;
 * - **never anything live under a week**: the archive that replaced `--old` must have been written at
 *   least seven days ago — the earliest it can have gone live on Vercel — so a cached client or a
 *   lagging deploy still finds its tiles (§2.5: *no sooner than a week after the new one is live*);
 * - and the `<campaign>` named must be the replacement, newer than `--old`: cleanup is run *from*
 *   the build that superseded it, so the two can't be swapped by a typo.
 *
 * The current build's own shards stay until a later build's cleanup removes them as the old one's:
 * that build's verify already passed, and its URL is the newest.
 */

import {
  archiveKey,
  buildPrefix,
  indexKey,
  manifestKey,
  parseArchiveKey,
  parseCampaign,
  publishPrefix,
} from './keys';

/** One object in a listing of the publish prefix. */
export interface ListedObject {
  /** The bucket key. */
  key: string;
  /** When it was written. */
  modified: Date;
}

export const LIVE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface CleanupPlan {
  /** Keys to delete, the published three first. */
  deleteKeys: string[];
  /** The old build's private prefix, deleted whole. */
  deletePrefix: string;
  /** For the report: what replaced it and when. */
  replacedBy: string;
  replacedAt: Date;
}

/** A refusal: nothing was deleted. */
export class CleanupRefusal extends Error {
  override name = 'CleanupRefusal';
}

const refuse = (message: string): never => {
  throw new CleanupRefusal(message);
};

/** The old campaign id an archive key belongs to. */
function campaignOf(key: string): { campaign: string; pilot?: string } {
  const read = parseArchiveKey(key);
  return read.pilot === null
    ? { campaign: `naip-${read.date}` }
    : { campaign: `naip-pilot-${read.date}`, pilot: read.pilot };
}

/**
 * The plan, or a refusal. `listing` is every object under `old`'s publish prefix; `liveArchiveUrl`
 * is what the web's env points at — `null` when it isn't set there (nothing is live yet), `undefined`
 * when the env couldn't be read at all, which is refused (the check is never skipped).
 */
export function planCleanup(args: {
  campaign: string;
  pilot: string | null;
  old: string;
  listing: readonly ListedObject[];
  liveArchiveUrl: string | null | undefined;
  now: Date;
}): CleanupPlan {
  const { campaign, old, listing, now } = args;
  const pilot = args.pilot ?? undefined;
  const target = parseArchiveKey(old);
  const current = parseCampaign(campaign);
  if ((target.pilot ?? undefined) !== pilot) {
    refuse(
      `--old ${old} is ${target.pilot === null ? 'a production key' : `pilot ${target.pilot}'s`}, this run is ${pilot === undefined ? 'production' : `pilot ${pilot}`}`,
    );
  }
  const replacement = archiveKey(campaign, pilot);
  if (replacement === old) refuse(`--old is this build's own archive (${old})`);
  if (target.date >= current.date) {
    refuse(
      `--old ${old} is not older than ${campaign}: cleanup runs from the build that replaced it`,
    );
  }

  const prefix = publishPrefix(campaign, pilot);
  const archives = listing
    .filter(
      (o) =>
        o.key.startsWith(prefix) &&
        o.key.slice(prefix.length).match(/^naip-summer-\d{8}\.pmtiles$/),
    )
    .map((o) => ({ ...o, date: parseArchiveKey(o.key).date }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!archives.some((a) => a.key === old))
    refuse(`${old} is not in the bucket: nothing to delete`);
  const newest = archives[archives.length - 1] as (typeof archives)[number];
  if (newest.key === old) refuse(`${old} is the newest archive: it is never deleted`);
  const next = archives.find((a) => a.key === replacement);
  if (next === undefined) refuse(`${replacement}, which replaces it, is not in the bucket`);
  const replacedAt = (next as (typeof archives)[number]).modified;
  const age = now.getTime() - replacedAt.getTime();
  if (age < LIVE_GRACE_DAYS * DAY_MS) {
    refuse(
      `${replacement} was written ${(age / DAY_MS).toFixed(1)} days ago: ${old} stays until it has been live a week`,
    );
  }
  if (args.liveArchiveUrl === undefined) {
    refuse(
      "apps/web/.env can't be read, so what the web points at (VITE_NAIP_PMTILES_URL) can't be told: run cleanup from a checkout that has it",
    );
  }
  if (args.liveArchiveUrl?.replace(/[?#].*$/, '').endsWith(`/${old}`)) {
    refuse(
      `${old} is the archive the web points at (VITE_NAIP_PMTILES_URL): repoint and redeploy first`,
    );
  }

  const was = campaignOf(old);
  return {
    deleteKeys: [
      archiveKey(was.campaign, was.pilot),
      indexKey(was.campaign, was.pilot),
      manifestKey(was.campaign, was.pilot),
    ],
    deletePrefix: buildPrefix(was.campaign, was.pilot),
    replacedBy: replacement,
    replacedAt,
  };
}

/**
 * Read `VITE_NAIP_PMTILES_URL`'s value out of an env file's text, without printing it: the last
 * assignment wins, quotes and a trailing comment stripped; `null` when unset or blank.
 */
export function envValue(text: string, name: string): string | null {
  let value: string | null = null;
  for (const line of text.split('\n')) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    let v = (m[1] as string).trim();
    if (/^["']/.test(v))
      v = v.slice(
        1,
        v.indexOf(v[0] as string, 1) === -1 ? undefined : v.indexOf(v[0] as string, 1),
      );
    else v = v.replace(/\s+#.*$/, '');
    value = v === '' ? null : v;
  }
  return value;
}
