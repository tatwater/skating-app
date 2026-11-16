/**
 * **A town's label — one function for every list, filter and pin** (B01-3l). A town is an entry keyed
 * by its boundary (`tiger/<GEOID>`), never by its name: Plattsburgh the town and Plattsburgh the city
 * are two. When two loaded subdivisions of one state share a name, each entry carries its kind — the
 * legal class TIGER appends to the name in its full name (`NAMELSAD`: "Plattsburgh city") — and the
 * label shows it: "Plattsburgh (city), NY". Every other town reads exactly as before.
 */

/** A town as a label reads it: its name, its state, and its kind when its name is shared. */
export interface TownLabelInput {
  readonly name: string;
  readonly state?: string | null;
  readonly kind?: string | undefined;
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

/** A town's name as a list shows it: "Plattsburgh (city)" when its kind is carried, else its name. */
export function townName(town: TownLabelInput): string {
  return town.kind ? `${town.name} (${town.kind})` : town.name;
}

/** A town's label with its state: "Plattsburgh (city), NY" — or its name alone with no state. */
export function townLabel(town: TownLabelInput): string {
  return town.state ? `${townName(town)}, ${town.state}` : townName(town);
}
