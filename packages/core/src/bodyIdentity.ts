/**
 * How an incoming catalogue feature finds the body it already is — the upsert rule (N7, D93).
 *
 * ## The job `externalId` used to do, and why it cannot keep doing it
 *
 * `externalId` is doing three unrelated jobs at once: it is the **upsert key** (does this row already
 * exist?), the **tile stamp** (which body did this contour belong to?), and the **identity** (what is
 * this lake?). D93 splits them, and splitting them leaves the upsert key homeless: `waterBodyKey` is
 * minted by us, so it is by definition not derivable from an incoming feature and cannot answer
 * "have I seen this before?".
 *
 * The answer has to come from the **catalogue ids** — which means a multi-key lookup, and that has a
 * failure mode worth naming before it is met in production: two ids on one incoming feature can point
 * at **two different stored rows**.
 *
 * ## Why not derive the key from the geometry
 *
 * Asked and rejected (founder, 2026-08-03). D92's entire purpose is to possibly change *which
 * catalogue draws a lake* — which changes the polygon, the bbox, and therefore any key derived from
 * them, at exactly the moment identity must not move. It would also repeat `externalId`'s sin at a
 * worse ratio: a foreign key at least changes rarely; a shoreline is edited continuously. The useful
 * half of that idea is a **blocking key** for dedup, and `waterBodyCells` (N1) already is one.
 *
 * ## The rule
 *
 * | incoming matches | verdict | why |
 * | --- | --- | --- |
 * | nothing | `insert` | a lake we have never seen |
 * | exactly one row, by one or more ids | `patch` | the normal case — update in place, `_id` never moves |
 * | two ids, two **different** rows | `merge` | reconciliation missed a duplicate; never create a third |
 * | one id, two rows | `conflict` | corrupt state — an id must be unique in the corpus |
 *
 * **`patch` and never delete-recreate.** User content keys off the Convex `_id`. On dev that is twelve
 * objects with zero dangling references, and keeping it that way is what makes "change a lake's
 * geometry source" a field update rather than a migration.
 *
 * **`merge` is the case the ordering exists to make rare.** Reconciliation writes `nhdId` onto OSM
 * bodies *before* any NHD geometry is imported (campaign step 2, before step 5), so by the time an
 * NHD-only feature arrives, the bodies it might collide with already carry their NHD ids. Get that
 * ordering wrong and every NHD-only lake arrives as a duplicate of an OSM lake we already had.
 *
 * **`conflict` throws rather than guessing.** One id resolving to two stored rows means the corpus
 * already violates its own uniqueness invariant, and picking one at random would bury that.
 */

/** The catalogue ids an incoming feature can carry. All optional; at least one must be present. */
export interface CatalogueIds {
  /** `way/<id>` or `relation/<id>`. */
  osmId?: string | undefined;
  /** NHD `Permanent_Identifier`, normalized — GUID or legacy numeric. */
  nhdId?: string | undefined;
  /** 3DHP `id3dhp`. */
  threeDhpId?: string | undefined;
}

/**
 * `gnisId` is **deliberately not** part of the upsert key.
 *
 * It is the one identifier all three catalogues share, which makes it an excellent *candidate
 * generator* for reconciliation — but GNIS names **places**, and a catalogue may split one place into
 * several features. Measured against the archives: **92 GNIS ids resolve to more than one NHD body**
 * (0.8% of 10,984). Upserting on it would merge those lakes. It proposes; `polygonIoU` adjudicates;
 * only the per-catalogue ids decide identity.
 */
export const GNIS_IS_NOT_AN_UPSERT_KEY = true;

/** The id fields, in the order a lookup should try them. Exported so callers cannot drift from it. */
export const CATALOGUE_ID_FIELDS = ['osmId', 'nhdId', 'threeDhpId'] as const;
export type CatalogueIdField = (typeof CATALOGUE_ID_FIELDS)[number];

/** What a lookup found: for each id present on the incoming feature, the stored key it resolved to. */
export interface IdMatch<Key> {
  field: CatalogueIdField;
  value: string;
  /** The stored row's key. More than one means the corpus violates uniqueness — see `conflict`. */
  keys: readonly Key[];
}

export type UpsertVerdict<Key> =
  /** No id matched anything. Mint a `waterBodyKey` and insert. */
  | { readonly action: 'insert' }
  /** Exactly one stored row. Patch it in place; `_id` and `waterBodyKey` are untouched. */
  | { readonly action: 'patch'; readonly key: Key; readonly matchedBy: CatalogueIdField[] }
  /**
   * Two or more stored rows, each matched by a different id. Reconciliation missed a duplicate.
   * `into` is the survivor and `absorb` the rest — never a third row.
   */
  | {
      readonly action: 'merge';
      readonly into: Key;
      readonly absorb: readonly Key[];
      readonly matchedBy: CatalogueIdField[];
    }
  /** One id resolved to several rows: the corpus already violates uniqueness. Refuse to guess. */
  | { readonly action: 'conflict'; readonly reason: string };

export interface ResolveOptions<Key> {
  /**
   * Which of several colliding rows survives a merge.
   *
   * Defaults to the **first** match in `CATALOGUE_ID_FIELDS` order, i.e. an OSM-keyed row outranks an
   * NHD-keyed one. That is not a claim about geometry quality — D92 decides that per lake through
   * `geometrySource` — it is a claim about **attachment**: the OSM lane has been the corpus since
   * Phase 1, so its rows are the ones carrying reports, hazards, sub-areas and favourites. Merging
   * *into* them keeps the most user content on its original `_id`.
   */
  preferSurvivor?: (candidates: readonly { key: Key; field: CatalogueIdField }[]) => Key;
}

/**
 * Decide what an incoming feature should do, given what each of its ids resolved to.
 *
 * Pure: the caller does the lookups (which are index reads), this makes the decision. That split is
 * what lets the interesting cases — merge and conflict — be tested exhaustively without a database.
 */
export function resolveUpsert<Key>(
  ids: CatalogueIds,
  matches: readonly IdMatch<Key>[],
  options: ResolveOptions<Key> = {},
): UpsertVerdict<Key> {
  if (!CATALOGUE_ID_FIELDS.some((f) => ids[f])) {
    return {
      action: 'conflict',
      reason:
        'incoming feature carries no catalogue id at all — it cannot be upserted, only counted as a drop',
    };
  }

  // One id resolving to several rows is a corpus-level invariant violation. Report it before anything
  // else, because every other verdict below would be built on a corpus we have just proven wrong.
  const ambiguous = matches.find((m) => m.keys.length > 1);
  if (ambiguous) {
    return {
      action: 'conflict',
      reason: `${ambiguous.field}=${ambiguous.value} resolves to ${ambiguous.keys.length} stored bodies; an identifier must be unique in the corpus`,
    };
  }

  const hits = matches.filter((m) => m.keys.length === 1);
  if (hits.length === 0) return { action: 'insert' };

  // **Ranked by `CATALOGUE_ID_FIELDS`, not by the order the caller happened to pass its lookups in.**
  // The default survivor rule reads `distinct[0]`, so leaving this in caller order would make which
  // row survives a merge depend on the shape of someone else's code — a nondeterministic merge, and
  // an untraceable one, since both orderings look correct at the call site.
  const rank = (field: CatalogueIdField) => CATALOGUE_ID_FIELDS.indexOf(field);
  const distinct: { key: Key; field: CatalogueIdField }[] = [];
  for (const hit of [...hits].sort((a, b) => rank(a.field) - rank(b.field))) {
    const key = hit.keys[0] as Key;
    if (!distinct.some((d) => d.key === key)) distinct.push({ key, field: hit.field });
  }
  const matchedBy = hits.map((h) => h.field);

  if (distinct.length === 1) {
    return { action: 'patch', key: (distinct[0] as { key: Key }).key, matchedBy };
  }

  const into = options.preferSurvivor
    ? options.preferSurvivor(distinct)
    : (distinct[0] as { key: Key }).key;
  return {
    action: 'merge',
    into,
    absorb: distinct.filter((d) => d.key !== into).map((d) => d.key),
    matchedBy,
  };
}

/**
 * Whether a verdict may run unattended.
 *
 * `insert` and `patch` are the campaign's normal traffic. **`merge` is not** — it collapses two rows
 * that user content may point at, and the dedup queue already exists for exactly this kind of
 * decision. An automatic merge that is wrong is unrecoverable in a way a queued one is not, and the
 * measured frequency says queueing is affordable: only 92 GNIS ids fan out across the whole archive,
 * and the ordering rule keeps id collisions rarer still.
 */
export function requiresReview<Key>(verdict: UpsertVerdict<Key>): boolean {
  return verdict.action === 'merge' || verdict.action === 'conflict';
}
