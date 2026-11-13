import { WATER_BODY_CLASSES, waterBodyClassLabel } from '@skating/core';

import { COMPLETENESS_FIELD_COUNT } from '../body/completeness';
import type { BodyRow } from './bodiesModel';

/**
 * The facets that narrow a lane: the state tabs over the list, and the rest behind *Filter*. Data,
 * not code — the menu, the chips, the URL and the kicker all read this list, so a facet is one
 * entry here.
 *
 * **One rule for choosing**: options within a facet widen (any of them), facets narrow each other
 * (all of them). A facet with nothing chosen doesn't narrow.
 */

/** How many fields every body should have: the shared rule's ten. */
const COMPLETENESS_FIELDS = COMPLETENESS_FIELD_COUNT;

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

export const FACET_IDS = [
  'class',
  'size',
  'outline',
  'putins',
  'reports',
  'complete',
  'curation',
] as const;
export type FacetId = (typeof FACET_IDS)[number];

/** What is chosen: option ids per facet. A facet that isn't here doesn't narrow. */
export type FacetSelection = Partial<Record<FacetId, readonly string[]>>;

/** How many bodies each option would leave, when the read says (`null`: no count). */
export type FacetCounts = Partial<Record<FacetId, Partial<Record<string, number>>>>;

export const FACETS: readonly Facet[] = [
  {
    id: 'class',
    label: 'Class',
    options: WATER_BODY_CLASSES.map((c) => ({ id: c, label: waterBodyClassLabel(c) })),
  },
  {
    id: 'size',
    label: 'Size',
    options: [
      { id: 'under-10', label: 'Under 10 ac' },
      { id: '10-100', label: '10–100', chip: '10–100 ac' },
      { id: '100-1000', label: '100–1,000', chip: '100–1,000 ac' },
      { id: '1000-up', label: '1,000 and up', chip: '1,000 ac and up' },
    ],
  },
  {
    id: 'outline',
    label: 'Outline',
    options: [
      { id: 'catalog', label: 'From a catalog' },
      { id: 'drawn', label: 'Drawn by staff' },
    ],
  },
  {
    id: 'putins',
    label: 'Put-ins',
    options: [
      { id: 'some', label: 'Has put-ins' },
      { id: 'none', label: 'None yet', chip: 'No put-ins yet' },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    options: [
      { id: 'season', label: 'Reported this season' },
      { id: 'never', label: 'Never reported' },
    ],
  },
  {
    id: 'complete',
    label: 'Complete',
    options: [
      { id: 'all', label: `All ${COMPLETENESS_FIELDS}` },
      {
        id: 'most',
        label: `8–${COMPLETENESS_FIELDS - 1}`,
        chip: `8–${COMPLETENESS_FIELDS - 1} complete`,
      },
      { id: 'under-8', label: 'Under 8', chip: 'Under 8 complete' },
    ],
  },
  {
    id: 'curation',
    label: 'Curation',
    options: [
      { id: 'curated', label: 'Curated' },
      { id: 'asks', label: 'Open asks' },
      { id: 'intake', label: 'Intake reason' },
      { id: 'enrichment', label: 'Awaiting enrichment' },
    ],
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

// ── Matching, over a lane held whole ─────────────────────────────────────────────────────────

/** What a facet needs to know about a body beyond the row (`null`: not recorded). */
export interface BodyFacts {
  outline: 'catalog' | 'drawn' | null;
  putIns: number | null;
  curated: boolean | null;
  intake: boolean | null;
  awaitingEnrichment: boolean | null;
}

const ACRE_SQM = 4046.8564224;

function sizeOf(areaSqM: number): string {
  const acres = areaSqM / ACRE_SQM;
  if (acres < 10) return 'under-10';
  if (acres < 100) return '10-100';
  if (acres < 1000) return '100-1000';
  return '1000-up';
}

function completeOf(have: number, of: number): string {
  if (have >= of) return 'all';
  if (have >= 8) return 'most';
  return 'under-8';
}

/**
 * Which options of `facet` a body falls under, or `null` when the fact behind it isn't recorded —
 * a body whose fact is unknown matches no option of that facet, so a filter never guesses.
 */
export function optionsOf(row: BodyRow, facts: BodyFacts, facet: FacetId): string[] | null {
  switch (facet) {
    case 'class':
      return [row.bodyClass];
    case 'size':
      return row.areaSqM === null ? null : [sizeOf(row.areaSqM)];
    case 'outline':
      return facts.outline === null ? null : [facts.outline];
    case 'putins':
      return facts.putIns === null ? null : [facts.putIns > 0 ? 'some' : 'none'];
    case 'reports':
      // "Never reported" needs the all-time count, which no row carries; only this season's is known.
      return row.reports === null ? null : row.reports > 0 ? ['season'] : [];
    case 'complete':
      return row.complete === null ? null : [completeOf(row.complete.have, row.complete.of)];
    case 'curation': {
      const known = [facts.curated, row.asks, facts.intake, facts.awaitingEnrichment];
      if (known.every((k) => k === null)) return null;
      return [
        ...(facts.curated === true ? ['curated'] : []),
        ...(row.asks !== null && row.asks > 0 ? ['asks'] : []),
        ...(facts.intake === true ? ['intake'] : []),
        ...(facts.awaitingEnrichment === true ? ['enrichment'] : []),
      ];
    }
  }
}

/** Whether a body passes every applied facet (any option within one, all facets together). */
export function matchesSelection(
  row: BodyRow,
  facts: BodyFacts,
  selection: FacetSelection,
): boolean {
  return FACET_IDS.every((facet) => {
    const chosen = selection[facet];
    if (chosen === undefined || chosen.length === 0) return true;
    const has = optionsOf(row, facts, facet);
    return has !== null && chosen.some((c) => has.includes(c));
  });
}
