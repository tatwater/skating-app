/**
 * **A town's label — one function for every list, filter and pin** (B01-3l). A town is an entry keyed
 * by its boundary (`tiger/<GEOID>`), never by its name: Plattsburgh the town and Plattsburgh the city
 * are two. When two loaded subdivisions of one state share a name, each entry carries its kind — the
 * legal class TIGER appends to the name in its full name (`NAMELSAD`: "Plattsburgh city") — and the
 * label shows it: "Plattsburgh (city), NY". Every other town reads exactly as before.
 */

/** A town as a label reads it: its name, its state, and what tells it from a namesake. */
export interface TownLabelInput {
  readonly name: string;
  readonly state?: string | null;
  /** Its kind ("city"), when a namesake in its state is of another kind. */
  readonly kind?: string | undefined;
  /**
   * Its county ("Clinton County"), when a namesake in its state is of the same kind (B01-3m) — New
   * York's two Clinton towns. Never a county guessed: the boundary key's own (its GEOID's first five
   * digits are its county's), as the loaded county boundary names it.
   */
  readonly inCounty?: string | undefined;
}

/**
 * A subdivision sharing a town's name in its state: its boundary, and its kind — '' when its full
 * name gives none, `null` when it carries no full name yet (mid-load, B01-3p): not known.
 */
export interface Namesake {
  readonly id: string;
  readonly kind: string | null;
}

/**
 * **What tells a town from its namesakes** — the one rule (B01-3l, B01-3m). With no other
 * subdivision of its name in its state, nothing. Its kind shows where the namesakes carry more than
 * one kind; its county shows where another namesake has its own kind — the kind alone can't tell
 * them apart. Both, where both are needed ("Plattsburgh (city, Clinton County)").
 *
 * **A namesake whose kind is not known yet holds every tell back** (B01-3p): mid-load, before its
 * full name arrives, it is neither another kind nor this one, so the town reads by its name alone —
 * never a kind or a county the loaded layer does not prove. Its next recompute tells it. The town
 * itself counts too: one whose own full name has not loaded (its own entry `null`) is not known to
 * share a kind with anyone, so it claims no county either.
 */
export function namesakeTells(
  id: string,
  kind: string,
  namesakes: readonly Namesake[],
): { kind: boolean; county: boolean } {
  const others = namesakes.filter((n) => n.id !== id);
  if (others.length === 0 || namesakes.some((n) => n.kind === null)) {
    return { kind: false, county: false };
  }
  const kinds = new Set([kind, ...others.map((n) => n.kind)]);
  return { kind: kinds.size > 1, county: others.some((n) => n.kind === kind) };
}

/** A boundary's kind as a namesake carries it: `null` without a full name, '' with one giving none. */
export function namesakeKindOf(name: string, fullName: string | undefined): string | null {
  return fullName === undefined ? null : (townKindOf(name, fullName) ?? '');
}

/**
 * The kind TIGER gives a subdivision — the suffix of its full name past its name ("Plattsburgh city"
 * → "city"), or `undefined` when the full name doesn't extend the name (or there is none). Read, never
 * guessed.
 */
export function townKindOf(name: string, fullName: string | undefined): string | undefined {
  if (fullName === undefined) return undefined;
  const full = fullName.trim();
  const base = name.trim();
  if (!full.startsWith(`${base} `)) return undefined;
  const kind = full.slice(base.length).trim();
  return kind === '' ? undefined : kind;
}

/**
 * A town's name as a list shows it: "Plattsburgh (city)", "Clinton (Clinton County)" — what tells it
 * from a namesake, when carried — else its name.
 */
export function townName(town: TownLabelInput): string {
  const tells = [town.kind, town.inCounty].filter((t): t is string => t !== undefined && t !== '');
  return tells.length > 0 ? `${town.name} (${tells.join(', ')})` : town.name;
}

/** A town's label with its state: "Plattsburgh (city), NY" — or its name alone with no state. */
export function townLabel(town: TownLabelInput): string {
  return town.state ? `${townName(town)}, ${town.state}` : townName(town);
}
