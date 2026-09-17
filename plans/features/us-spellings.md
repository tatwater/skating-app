# Next-gen — US spellings everywhere: what a sweep found, and the traps in it

> **Scoped 2026-09-16 (A09 kickoff), deliberately deferred until A09 lands.** Founder: *"let's not use
> the UK spelling of words like 'favourites' or 'colours' etc anywhere in our app. If you spot
> non-US spellings in our planning docs, let's do a codebase-wide find/replace for them."* Sized at
> the kickoff and parked, because a ~300-file mechanical diff bundled into a real phase would drown
> its review. **Its own PR, after A09.** New text written from 2026-09-16 on uses US spellings.

> **✅ Built 2026-09-17, one PR, two commits (D185).** The record of what the build found is at the
> bottom — read it before trusting the sizing above. This file is the one place in the tree that
> keeps the UK words on purpose: the founder's ask and the word list *are* the record.
> (The text pass, the identifier pass and the migrations skipped it by name.)

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

---

## What the build found (2026-09-17, `main` at `b9cf4117`)

**The sizing was low by ~70%.** Word-boundaried and case-insensitive over *tracked* files, the tree
held **521 files / ~3,090 hits**, not ~300 files: roughly 1,490 in code comments, 735 in Markdown,
310 in string literals, and ~60 distinct real identifiers. The 2026-09-16 count excluded `exports/`
as gitignored, but `exports/mascoma` and `exports/weather-timeline` are tracked (20 hits, one
identifier). User-visible copy was ~20 strings, nearly all admin-facing; the skater-facing ones were
the bounty labels `Cancelled` / `Cancelling…` and one "may have been cancelled" message.

**Traps confirmed, one missed, one reversed:**

- Trap 1 was **three** stored values, not two. `licence` is the persisted key in every archive
  `manifest.json` (`.raw*/` for lake-depth, elevation, NHD, 3DHP, GNIS, TIGER and the 9,553
  per-grid-point NREL wind manifests), and `isRunnable()` refuses an archive whose manifest has no
  license — so a rename with no migration would have stopped every ETL. Then the founder reversed
  the trap-1 rule outright: **all three migrate** (D185). Cost, measured first: 0 `cancelled`
  bounties on dev, 1 `catalogue_edh_coverage` row, prod uninitialized, manifests local with
  additive mirrors.
- Trap 2's false positives are real and worse than "rename by hand": `recentReportCount` contains
  `centRe`, `subAreaListed` contains `reaLis`, `scanCells` contains `anCell`. Any stem match inside
  an identifier has to respect camelCase and `_` segment boundaries.
- Trap 3/4: `harbour` is an OSM tag value in identifier position (`OSM_WATER`'s key in
  `waterClass.ts`), `tidalBand.ts` deliberately matches both spellings in place names, a test feeds
  `parseOsmDepthMeters('2 metres')` as OSM user text (and the identifier pass renamed the
  `metre|metres` alternatives *inside that parser's regex* — a regex literal is code state to a
  tokenizer, and the test caught it), and A02's table lists "Burlington Harbour" as a
  name alias. All four stay.
- `fulfilling` / `fulfilled` / `enrolling` are the US forms too — the plan's raw `fulfil` count (44
  files) was mostly those. `grey` was prose only; no design token. `LICENSE`'s one hit was
  "fulfilling".
- Two Biome format errors: shortening a JSX line and a `lines.push('…')` argument crossed the
  reflow threshold. `biome format --write` on the two files.

**How it ran — two commits, one PR:**

1. *The text pass.* A scanner (not `sed`) that tracks state through `//` and `/* */` comments,
   `'…'` / `"…"` / template strings (recursing into `${}` holes as code), JSX text after a real tag
   close, `#` comments and strings in Python/shell, and Markdown outside fences and code spans.
   Identifiers are code state and untouched. 497 files, 2,402 lines. Four regex literals asserting
   on rewritten copy and four JSX strings after a `{hole}` were fixed by hand.
2. *The identifier pass + the migrations.* A token mapper that renames a UK stem only at a segment
   boundary — 73 distinct tokens across 129 files, code and the Markdown that quotes it, verified by
   `pnpm check-types`, `py_compile` / `bash -n` for the scripts, and a zero-leftover grep of every
   old token. Two files renamed (`CatalogueCoverage.tsx` and its test). Then D185's three
   migrations, each idempotent: the plain enum rename, `analytics.renameMetricKey`, and
   `scripts/lib/rename-manifest-key.py`.

**What stays UK on purpose** — the complete list, for the next sweep and for any guard test:
this file; `water=harbour` (OSM tag, `waterClass.ts:113`); the place-name regex in
`scripts/etl/src/tidalBand.ts`; the OSM depth-unit parser's regex (`metre|metres` alongside `meter|meters`) and its `'2 metres'`
fixture in `scripts/etl/src/transform.ts` / `.test.ts`;
"Burlington Harbour" in `phases/A02-body-editor-and-subareas.md`; agency `copyrightText` (fetched
at runtime, never in the tree); and lowercase literals that name things that existed (branch names,
campaign ids, commit scopes) — the same rule as the renumbering.

**Deliberately not built (founder calls, 2026-09-17):** a guard test. The rule in `plans/README.md`
§ Words and `CLAUDE.md` stands on review alone; if it drifts again, the inventory in this section
is what a test would assert.

#### Data runs

- **2026-09-17 — manifest key rename:** 9,568 manifests `licence` → `license` (9,553 wind-climate,
  5 lake-depth, 5 NHD, 2 3DHP, 1 GNIS, 1 elevation, 1 TIGER); re-run is a no-op; mirrors pushed
  after (see below).
- **2026-09-17 — `renameMetricKey` on dev:** `catalogue_edh_coverage` → `catalog_edh_coverage`.
- **Bounties:** nothing to run — 0 rows held `cancelled` on dev; prod has no rows.

#### Owed

- The R2 mirror pushes after the manifest rename (one per archive script), and the same rename on
  any other machine that holds a `.raw*` archive.
- The installed preview APK maps bounty status by the old key until it is rebuilt — harmless while
  no bounty is canceled on dev.
