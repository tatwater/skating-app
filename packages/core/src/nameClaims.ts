/**
 * **Every name a publisher gave this water, kept — not just the one that won** (N7).
 *
 * ## The bug this exists to fix
 *
 * `NAME_SOURCE_RANK` picks the stored name by *authority*: `gnis > nhd > 3dhp > osm`. That is the
 * right rule and its own docstring already names what it costs — *"OSM frequently carries the name a
 * local would use where the gazetteer carries an official one, and we lose that."*
 *
 * Measured on the `n7-2026-08-07` corpus, it costs **463 bodies**, every one of them named, carrying
 * a GNIS id, and scoring `high` on both class and outline — so they are unambiguously the same lake
 * under two labels. The clearest is Auburn, Maine's own water supply: NHD's `gnis_name` for the
 * feature is **`The Basin`** and OSM calls it **`Lake Auburn`**. We store `The Basin`, and
 * `waterBodies`' search index covers `name` **only** — so a skater typing "Lake Auburn" finds
 * nothing at all.
 *
 * That is not a naming disagreement. It is **data loss with a search outage on top**, and the losing
 * name was sitting in the merge the whole time.
 *
 * ## Keeping them turns a queue into a display preference
 *
 * With every claim on the row, a name conflict stops being something a moderator must resolve before
 * the corpus is correct — both names are findable either way — and becomes a question of which one
 * to *show*. `waterBodySubAreas` reached this shape first (`aliases` + a denormalised `searchText`);
 * this is the same idea one table over, plus the provenance a sub-area's operator-typed aliases
 * cannot have.
 *
 * **Why claims rather than bare strings.** A moderator choosing between "Lake Auburn" and "The Basin"
 * needs to know which publisher said which — *"OSM, a mapper's free text"* against *"NHD's
 * `gnis_name`, which IS GNIS"* is the whole content of that decision. A `string[]` throws exactly the
 * information the chooser needs.
 *
 * **A moderator's own alias is a claim too**, with `source: 'user'`. One field rather than two, and
 * `NAME_SOURCE_RANK` already ranks `user` above every catalogue *"so that the day one does, the rule
 * is already right"*.
 */

import type { ClaimSource } from './confidence';

/** One publisher's name for a body, kept whether or not it won. */
export interface NameClaim {
  readonly source: ClaimSource;
  readonly value: string;
}

/** Case-insensitive, whitespace-insensitive key. Not `sameName` — see `distinctNameClaims`. */
function key(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The claims worth storing: trimmed, blank-free, and one per distinct string.
 *
 * **Deduped on the raw string, deliberately not through `sameName`.** `sameName` folds apostrophes,
 * possessive `s` and word order so that `Harvey's Lake` and `Harveys Lake` count as one *claim* —
 * which is right when deciding whether the publishers disagree, and wrong here. Convex's search
 * tokenizer does no such folding, so those two spellings produce different tokens and keeping both
 * is the difference between a search hitting and missing. The scorer's question is "do they
 * disagree?"; this one's is "what might someone type?".
 *
 * First claim of a given string wins, so a caller that passes claims in authority order gets the
 * most authoritative source attached to each spelling.
 */
export function distinctNameClaims(claims: readonly NameClaim[]): NameClaim[] {
  const seen = new Set<string>();
  const out: NameClaim[] = [];
  for (const claim of claims) {
    const value = claim.value.trim();
    if (value.length === 0) continue;
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ source: claim.source, value });
  }
  return out;
}

/**
 * The other names this body goes by — every distinct claim except the one being displayed.
 *
 * Excluded case-insensitively rather than by identity, because the stored `name` has been through
 * `chooseName` and a claim may differ from it only in casing.
 */
export function aliasesFor(claims: readonly NameClaim[], displayName: string): string[] {
  const shown = key(displayName);
  return distinctNameClaims(claims)
    .filter((c) => key(c.value) !== shown)
    .map((c) => c.value);
}

/**
 * `[name, ...aliases]` as one string — **Convex search indexes a single field**, so an alias that is
 * not in it is not searchable, however faithfully it is stored.
 *
 * Shared by `waterBodies` and `waterBodySubAreas`. It was written for the second and copied nowhere,
 * which is what made adding it to the first a chance to have two subtly different join rules; the
 * sub-area version is now this one.
 */
export function searchTextFor(name: string, aliases: readonly string[] | undefined): string {
  return [name, ...(aliases ?? [])]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
}
