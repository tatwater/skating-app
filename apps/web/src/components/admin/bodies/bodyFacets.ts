import {
  COMPLETENESS_FIELDS,
  LIBRARY_FACET_IDS,
  LIBRARY_FACETS,
  type LibraryFacet,
  type LibraryFacetSelection,
  waterBodyClassLabel,
} from '@skating/core';

/**
 * The facets that narrow a lane: the state tabs over the list, and the rest behind *Filter*. Data,
 * not code — the menu, the chips, the URL and the kicker all read this list, so a facet is one
 * entry here. The ids — facets and options — are core's (`LIBRARY_FACETS`), the ones the server's
 * stored rows and counts are filed under; this module adds only their words.
 *
 * **One rule for choosing**: options within a facet widen (any of them), facets narrow each other
 * (all of them). A facet with nothing chosen doesn't narrow. The server answers the choice; the
 * page never filters a list itself.
 */

/** How many fields every body should have: core's ten. */
const FIELDS = COMPLETENESS_FIELDS.length;

export interface FacetOption {
  id: string;
  /** In the menu ("1,000 and up"). */
  label: string;
  /** On the applied chip and in the kicker, when the menu's words need their unit ("1,000 ac and up"). */
  chip?: string;
}

export interface Facet {
  id: FacetId;
  /** The facet's kicker ("Size"), written capitalized. */
  label: string;
  options: readonly FacetOption[];
}

/** Core's facets, in the menu's order — a facet core adds is one the page must word (`FACETS`). */
export const FACET_IDS: readonly LibraryFacet[] = LIBRARY_FACET_IDS;
export type FacetId = LibraryFacet;

/** What is chosen: option ids per facet. A facet that isn't here doesn't narrow. */
export type FacetSelection = LibraryFacetSelection;

/**
 * How many bodies each option would leave, as the read gives them. A facet absent here has no
 * counts for this query (the read answers a facet's counts exactly or not at all) — its options
 * show no number, never a zero.
 */
export type FacetCounts = Partial<Record<FacetId, Partial<Record<string, number>>>>;

/** Words for each of core's options of a facet: the menu's, and the chip's when it needs a unit. */
type OptionWords<F extends FacetId> = Record<
  (typeof LIBRARY_FACETS)[F][number],
  { label: string; chip?: string }
>;

const optionsOf = <F extends FacetId>(facet: F, words: OptionWords<F>): FacetOption[] =>
  (LIBRARY_FACETS[facet] as readonly (typeof LIBRARY_FACETS)[F][number][]).map((id) => ({
    id,
    ...words[id],
  }));

export const FACETS: readonly Facet[] = [
  {
    id: 'class',
    label: 'Class',
    options: LIBRARY_FACETS.class.map((c) => ({ id: c, label: waterBodyClassLabel(c) })),
  },
  {
    id: 'size',
    label: 'Size',
    options: optionsOf('size', {
      'under-10': { label: 'Under 10 ac' },
      '10-100': { label: '10–100', chip: '10–100 ac' },
      '100-1000': { label: '100–1,000', chip: '100–1,000 ac' },
      '1000-up': { label: '1,000 and up', chip: '1,000 ac and up' },
    }),
  },
  {
    id: 'outline',
    label: 'Outline',
    options: optionsOf('outline', {
      catalog: { label: 'From a catalog' },
      drawn: { label: 'Drawn by staff' },
    }),
  },
  {
    id: 'putins',
    label: 'Put-ins',
    options: optionsOf('putins', {
      some: { label: 'Has put-ins' },
      none: { label: 'None yet', chip: 'No put-ins yet' },
    }),
  },
  {
    id: 'reports',
    label: 'Reports',
    options: optionsOf('reports', {
      season: { label: 'Reported this season' },
      never: { label: 'Never reported' },
    }),
  },
  {
    id: 'complete',
    label: 'Complete',
    options: optionsOf('complete', {
      all: { label: `All ${FIELDS}` },
      most: { label: `8–${FIELDS - 1}`, chip: `8–${FIELDS - 1} complete` },
      'under-8': { label: 'Under 8', chip: 'Under 8 complete' },
    }),
  },
  {
    id: 'curation',
    label: 'Curation',
    options: optionsOf('curation', {
      curated: { label: 'Curated' },
      asks: { label: 'Open asks' },
      intake: { label: 'Intake reason' },
      enrichment: { label: 'Awaiting enrichment' },
    }),
  },
];

export function facetById(id: FacetId): Facet {
  // FACETS holds every FacetId (`bodyFacets.test.ts`).
  return FACETS.find((f) => f.id === id) as Facet;
}

/** The words an option wears on its chip. */
export function chipWords(option: FacetOption): string {
  return option.chip ?? option.label;
}

/** One applied option: what its chip says and how to take it off. */
export interface AppliedOption {
  facet: Facet;
  option: FacetOption;
}

/** The applied options in the menu's order — one chip each. Unknown ids are dropped. */
export function appliedOptions(selection: FacetSelection): AppliedOption[] {
  return FACETS.flatMap((facet) =>
    facet.options
      .filter((option) => selection[facet.id]?.includes(option.id) === true)
      .map((option) => ({ facet, option })),
  );
}

/** How many options are applied (the count on the Filter button). */
export function appliedCount(selection: FacetSelection): number {
  return appliedOptions(selection).length;
}

/** `option` on or off in `facet`; a facet left empty leaves the selection. */
export function toggleOption(
  selection: FacetSelection,
  facet: FacetId,
  option: string,
): FacetSelection {
  const current = selection[facet] ?? [];
  const next = current.includes(option)
    ? current.filter((o) => o !== option)
    : // Kept in the facet's own order, so a URL and a chip row read the same however they were built.
      facetById(facet)
        .options.map((o) => o.id)
        .filter((id) => id === option || current.includes(id));
  const { [facet]: _gone, ...rest } = selection;
  return next.length === 0 ? rest : { ...rest, [facet]: next };
}
