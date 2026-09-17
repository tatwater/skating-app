# Next-gen — US spellings everywhere: what a sweep found, and the traps in it

> **Scoped 2026-09-16 (A09 kickoff), deliberately deferred until A09 lands.** Founder: *"let's not use
> the UK spelling of words like 'favourites' or 'colours' etc anywhere in our app. If you spot
> non-US spellings in our planning docs, let's do a codebase-wide find/replace for them."* Sized at
> the kickoff and parked, because a ~300-file mechanical diff bundled into a real phase would drown
> its review. **Its own PR, after A09.** New text written from 2026-09-16 on uses US spellings.

---

## What the sweep found (2026-09-16, `main` at `5bb3f93`)

Files containing each word, excluding `node_modules`, `coverage`, `.scratch`, `.raw`, `dist`,
`_generated`, `training_data`, `exports`, `android`:

| word | files | | word | files |
| --- | --- | --- | --- | --- |
| metre / kilometre | 170 / 36 | | licence | 53 |
| centre | 99 | | honour | 52 |
| catalogue | 89 | | fulfil | 44 |
| neighbour | 82 | | modelled | 43 |
| labelled | 79 | | cancelled | 41 |
| behaviour | 68 | | normalise / denormalise | 32 / 7 |
| recognise | 31 | | grey | 27 |
| favourite | 25 | | summarise | 21 |
| colour | 14 | | programme | 11 |

Long tail (1–7 files each): organisation, organise, serialise, initialise, minimise, maximise,
optimise, prioritise, realise, emphasise, authorise, capitalise, standardise, analyse, labour,
flavour, harbour, theatre, defence, offence, travelled, totalled, enrol.

Roughly **300 distinct files**, the large majority in code comments and the `plans/` and `docs/`
prose; a minority in UI copy (the part that matters to a user) and README text.

---

## ⚠ The traps — things a blind find/replace would break

1. **`'cancelled'` is a stored enum value.** `BOUNTY_STATUSES = ['open', 'fulfilled', 'expired',
   'cancelled']` in `packages/convex/convex/lib/enums.ts` — rows on dev hold it. Renaming the
   *value* is a schema migration (widen → deploy → backfill → narrow). **Leave the literal; fix only
   prose.** (`fulfilled` is already US.)
2. **Identifiers spelled the UK way**, which a rename touches at every call site and, for exported
   names, across packages. Found: `catalogueIdsOf`, `catalogueIds`, `CatalogueIdField`,
   `CatalogueCoverage`, `assertedCatalogueIds`, `backfillCatalogueIds`, `lookupByCatalogueIds`,
   `deriveCatalogueIds`, `useCatalogue`, `catalogueHistory`, `catalogue_edh_coverage` (a metric
   key — **stored** in `metricSnapshots.metric`, so it is trap 1 again), `resolutionMetres`,
   `metresPerLngDegree`, `metresPerDegLng`, `toLocalMetres`, `segmentDistanceMetres`,
   `rangeDisplacementPerMetre`, `deg_per_metre`, `centre_lat` / `centre_lat_of` (ETL SQL/column
   names — check whether they are ours or a source's), `shortLicence`, `expectedLicence`,
   `licenceUrl`, `Normalised`, `Labelled`. Rename these with the type-checker, not `sed`, and
   **not** the two that are stored.
3. **Third-party text quoted verbatim** must stay as published: agency `copyrightText` in the
   bathymetry manifests and `PROVENANCE.md` (the credit we render is what we *agreed* to display),
   OSM / NHD / 3DHP field names, Open-Meteo and NWS parameter names, and any quoted email from the
   Google Group corpus.
4. **Proper nouns**: "Harbour" in a place name stays; "Appletree" is a bay, not a spelling. Check
   `harbour` hits by hand (3 files).
5. **`LICENSE` / `LICENSE-EXCEPTIONS.md`** are already US; the `licence` hits are prose and the
   identifiers above.
6. **`grey`**: Tailwind's palette is `gray`; the 27 hits are prose and possibly a token name in the
   design exports — check before replacing inside a class string.

---

## How to run it

- A word list (the table above, US forms beside them) applied to **comments, Markdown and string
  literals in UI copy only**, by a script that skips identifiers, import paths and anything inside
  a quoted third-party block; then the identifier renames by hand with `pnpm check-types` green.
- `pnpm lint` (Biome) and the full test suites after; snapshot tests with UK copy in them will move.
- One PR, titled as mechanical, with the traps above listed in its description so the reviewer
  knows what was deliberately left. Whether Greptile reviews it is the founder's call at the time.

## Related

[`phases/A09-subareas-as-places.md`](../phases/A09-subareas-as-places.md) (where this was found)
