/**
 * **The catalog, walked and kept** (B05 §2.1, §2.1.3): the select stage's side of core's
 * `walkNaipState` — the seven states in turn, the snapshot written beside the campaign, and read back
 * when the stage runs again.
 *
 * **A campaign reads one snapshot.** The first select of a campaign walks the catalog and writes it
 * to `<scratch>/<campaign>/inventory/` (`<st>.jsonl.gz`, one compact row per item, plus `walk.json`
 * saying when and how much); a re-run of the stage reads that instead of walking again, so a select
 * re-run after a refusal decides the same build. The private bucket's copy, under `inventoryKey`, is
 * the full run's executor's to upload; these files are the shape it uploads as-is.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  type FetchLike,
  NAIP_STATES,
  type NaipCatalogItem,
  type NaipState,
  walkNaipState,
} from '@skating/core';
import { writeFileAtomic } from './atomicFile';

/** `walk.json`: what the snapshot holds. */
export interface CatalogWalkRecord {
  /** The day the walk began, `YYYY-MM-DD` (UTC). */
  walkedOn: string;
  /** Items per state, as walked. */
  perState: Partial<Record<NaipState, number>>;
  /** STAC pages per state. */
  pages: Partial<Record<NaipState, number>>;
}

/** A snapshot of the catalog, walked now or read back. */
export interface CatalogSnapshot extends CatalogWalkRecord {
  items: NaipCatalogItem[];
  /** True when this run walked it; false when it was read from an earlier run of the campaign. */
  walked: boolean;
}

export interface WalkCatalogOptions {
  fetchFn: FetchLike;
  /** `scratchPaths(campaign).inventory`. */
  inventoryDir: string;
  /** Today, for `walkedOn`; injectable for tests. */
  now?: () => Date;
  /** Called once a state is walked (the run row's heartbeat). */
  onState?: (state: NaipState, items: number, pages: number) => void;
  /** Passed through to core's walk (retries, sleep, page size). */
  walk?: Parameters<typeof walkNaipState>[2];
}

const WALK_RECORD = 'walk.json';
const stateFile = (dir: string, state: NaipState) => join(dir, `${state.toLowerCase()}.jsonl.gz`);

/**
 * The seven states' items: the campaign's snapshot when one is complete on disk, else a fresh walk,
 * written state by state and recorded last (`walk.json`), so a walk that died midway is walked again
 * rather than read half.
 */
export async function walkCatalog(options: WalkCatalogOptions): Promise<CatalogSnapshot> {
  const kept = readSnapshot(options.inventoryDir);
  if (kept !== null) {
    // A kept snapshot holds all seven (`readSnapshot` checked each file against the record).
    for (const state of NAIP_STATES) {
      options.onState?.(state, kept.perState[state] as number, kept.pages[state] as number);
    }
    return kept;
  }

  mkdirSync(options.inventoryDir, { recursive: true });
  const walkedOn = (options.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const items: NaipCatalogItem[] = [];
  const perState: CatalogWalkRecord['perState'] = {};
  const pages: CatalogWalkRecord['pages'] = {};
  for (const state of NAIP_STATES) {
    const walk = await walkNaipState(options.fetchFn, state, options.walk);
    // Each file whole or not at all (`atomicFile.ts`): a walk cut short leaves no torn state file
    // for a copied-in walk or a later read to trip on, and `walk.json` is still written last.
    writeFileAtomic(stateFile(options.inventoryDir, state), gzipSync(toJsonl(walk.items)));
    items.push(...walk.items);
    perState[state] = walk.items.length;
    pages[state] = walk.pages;
    options.onState?.(state, walk.items.length, walk.pages);
  }
  const record: CatalogWalkRecord = { walkedOn, perState, pages };
  writeFileAtomic(join(options.inventoryDir, WALK_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, items, walked: true };
}

/** The campaign's snapshot, or `null` when there is none (or only part of one). */
export function readSnapshot(inventoryDir: string): CatalogSnapshot | null {
  const recordPath = join(inventoryDir, WALK_RECORD);
  if (!existsSync(recordPath)) return null;
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as CatalogWalkRecord;
  const items: NaipCatalogItem[] = [];
  for (const state of NAIP_STATES) {
    const rows = fromJsonl(
      gunzipSync(readFileSync(stateFile(inventoryDir, state))).toString('utf8'),
    );
    if (rows.length !== record.perState[state]) {
      throw new Error(
        `the snapshot's ${state} file holds ${rows.length} items, but walk.json says ${record.perState[state]}`,
      );
    }
    items.push(...rows);
  }
  return { ...record, items, walked: false };
}

function toJsonl(items: readonly NaipCatalogItem[]): string {
  return items.map((i) => JSON.stringify(i)).join('\n') + (items.length > 0 ? '\n' : '');
}

function fromJsonl(text: string): NaipCatalogItem[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as NaipCatalogItem);
}
