/**
 * Which sources a command should act on (N6b).
 *
 * Shared by `snapshot` and `verify` so the two can't drift about what `--state=NH` means — a
 * divergence there would be quietly awful: verifying one set and refreshing another is how a state
 * ends up reported clean and archived stale.
 *
 * **Per-state selection is the primary interface**, not a convenience. Agencies republish
 * independently, so "our records are out of date" is a per-state judgement and the refresh has to
 * match its granularity. Selecting nothing means everything, which is the right default for the first
 * run and the wrong one for a routine refresh — hence `verify` first, then a targeted `--refresh`.
 */

import type { BathymetrySource } from './types';

export interface SelectionRequest {
  /** Explicit source keys, from bare positional arguments. */
  keys: readonly string[];
  /** `--state=NH` (repeatable). Case-insensitive. */
  states: readonly string[];
}

/** Pull a selection out of raw argv. Unknown flags are ignored; the caller reads its own. */
export function parseSelection(args: readonly string[]): SelectionRequest {
  const keys: string[] = [];
  const states: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--state=')) {
      // `--state=NH,VT` and repeated `--state=` both work; neither is worth making a person remember.
      for (const part of arg.slice('--state='.length).split(',')) {
        const trimmed = part.trim();
        if (trimmed) states.push(trimmed.toUpperCase());
      }
    } else if (!arg.startsWith('--')) {
      keys.push(arg);
    }
  }
  return { keys, states };
}

/**
 * Resolve a selection against the registry.
 *
 * Throws on an unknown key or an unknown state rather than acting on a smaller set than the caller
 * asked for. A typo'd `--state=NY` silently matching nothing would report "all sources unchanged" —
 * which is both true and completely misleading, and is exactly the shape of failure this ETL keeps
 * finding in third-party data.
 */
export function selectSources(
  sources: readonly BathymetrySource[],
  request: SelectionRequest,
): BathymetrySource[] {
  if (request.keys.length === 0 && request.states.length === 0) return [...sources];

  const selected = new Map<string, BathymetrySource>();

  for (const key of request.keys) {
    const source = sources.find((s) => s.key === key);
    if (!source) {
      throw new Error(`unknown source key: ${key}. Known: ${sources.map((s) => s.key).join(', ')}`);
    }
    selected.set(source.key, source);
  }

  for (const state of request.states) {
    const matches = sources.filter((s) => s.state === state);
    if (matches.length === 0) {
      const known = [...new Set(sources.map((s) => s.state))].sort().join(', ');
      const hint =
        state === 'NY'
          ? ' New York publishes no lake bathymetry — see PROVENANCE.md §New York.'
          : '';
      throw new Error(`no sources for state: ${state}. Known: ${known}.${hint}`);
    }
    for (const source of matches) selected.set(source.key, source);
  }

  // Registry order, not selection order, so a run's logs read the same however it was invoked.
  return sources.filter((s) => selected.has(s.key));
}
