/**
 * The pure half of `seed-standing` (N7b): the gazetteer parser and the keep-list dedupe. Kept apart
 * from the CLI so the rules are covered and the subprocess glue is excluded, like `cli.ts`.
 */

import type { Destination } from './match';

/**
 * The gazetteer's rows as destinations — `water_body` is the name, `region` the state the corpus
 * analysis attributed it to. No coordinate: the mbox knows where people are, not where the lake is.
 */
export function gazetteerToDestinations(csv: string): Destination[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = (lines.shift() ?? '').split(',');
  const nameAt = header.indexOf('water_body');
  const regionAt = header.indexOf('region');
  if (nameAt < 0 || regionAt < 0) {
    throw new Error('gazetteer: expected `water_body` and `region` columns');
  }
  return lines.flatMap((line) => {
    const cols = line.split(',');
    const name = cols[nameAt]?.trim();
    const state = cols[regionAt]?.trim();
    if (!name || !state) return [];
    return [{ name, state, sources: ['community' as const] }];
  });
}

/** Two lists, one keep set: a lake on both is one entry, not two matches. */
export function dedupeDestinations(lists: readonly Destination[][]): Destination[] {
  const seen = new Set<string>();
  const out: Destination[] = [];
  for (const list of lists) {
    for (const d of list) {
      const key = `${d.state}:${d.name.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}
