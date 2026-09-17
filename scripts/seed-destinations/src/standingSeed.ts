/**
 * The pure half of `seed-standing` (A07b): the gazetteer parser and the keep-list dedupe. Kept apart
 * from the CLI so the rules are covered and the subprocess glue is excluded, like `cli.ts`.
 */

import type { Destination, MatchOutcome } from './match';

/**
 * Split one CSV line, honoring double-quoted fields and doubled quotes inside them — the same
 * splitter `scripts/lake-depth` uses (copied: the scripts do not depend on each other). A lake
 * named `"Pond, Little"` in the gazetteer must not shift the `region` column and get shelved for it.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * The gazetteer's rows as destinations — `water_body` is the name, `region` the state the corpus
 * analysis attributed it to. No coordinate: the mbox knows where people are, not where the lake is.
 *
 * And `region` is where the *posters* are: a Vermont list discusses Lake George, Lake Placid and
 * Sebago, and the first dry run left all three unmatched in "VT". `region_breakdown` (`VT:20;NY:15`)
 * names every state the lake was mentioned from, so those become the destination's `states` and
 * the matcher tries them all; `region` stays the headline state.
 */
export function gazetteerToDestinations(csv: string): Destination[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines.shift() ?? '');
  const nameAt = header.indexOf('water_body');
  const regionAt = header.indexOf('region');
  const breakdownAt = header.indexOf('region_breakdown');
  if (nameAt < 0 || regionAt < 0) {
    throw new Error('gazetteer: expected `water_body` and `region` columns');
  }
  return lines.flatMap((line) => {
    const cols = splitCsvLine(line);
    const name = cols[nameAt]?.trim();
    const state = cols[regionAt]?.trim();
    if (!name || !state) return [];
    const mentioned = (breakdownAt >= 0 ? (cols[breakdownAt] ?? '') : '')
      .split(';')
      .map((part) => part.split(':')[0]?.trim() ?? '')
      .filter((s) => s.length > 0);
    const states = [state, ...mentioned.filter((s) => s !== state)];
    return [
      { name, state, ...(states.length > 1 ? { states } : {}), sources: ['community' as const] },
    ];
  });
}

/**
 * The ids an apply run keeps: every match except one that rests on a poster state alone.
 * `region_breakdown` says where people wrote from, not where the water is, so a unique same-named
 * body in a mentioned state is a lead for the report, not evidence to shelve everything else by.
 */
export function keepIdsFor(outcomes: readonly MatchOutcome[]): string[] {
  return outcomes.flatMap((o) =>
    o.kind === 'matched' && !o.viaMentionedState ? [o.body._id] : [],
  );
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
