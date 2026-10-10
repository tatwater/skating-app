/**
 * The where question's cards for a located field, as data both sheets render (A10-6's carousel,
 * D193, D210): one card per selected chip — a type said of two places is two cards, *Still open*
 * and *Still open (2)* — each able to add one more place of its type. Built here once so the phone
 * and the console, and the ice and the sightings rows on each, cannot drift (the A10-9 review found
 * four hand copies of this).
 */

import {
  chipKeysOfType,
  type LocatedFieldKey,
  nextPlaceKey,
  type ReportSheetState,
  type SheetAction,
  selectedChips,
} from './reportSheet';
import type { Where } from './where';

export interface WhereCardModel {
  /** `field:key`, stable across renders. */
  id: string;
  label: string;
  /** The card's question when "Where is the {label}?" does not read (a sighting is a state). */
  question?: string;
  where: Where | undefined;
  onChange: (where: Where | undefined) => void;
  /** Add one more place of this card's type; returns the new card's id, for the caller to open. */
  onAnotherPlace: () => string;
}

export function whereCardsFor(
  state: ReportSheetState,
  field: LocatedFieldKey,
  dispatch: (action: SheetAction) => void,
  words: { label: (type: string) => string; question?: (type: string) => string },
): WhereCardModel[] {
  const seenOfType = new Map<string, number>();
  return selectedChips(state, field).map((chip) => {
    const type = (chip.value as { type: string }).type;
    const n = (seenOfType.get(type) ?? 0) + 1;
    seenOfType.set(type, n);
    const question = words.question?.(type);
    return {
      id: `${field}:${chip.key}`,
      label: n === 1 ? words.label(type) : `${words.label(type)} (${n})`,
      ...(question !== undefined ? { question } : {}),
      where: (chip.value as { where?: Where }).where,
      onChange: (where) =>
        dispatch({
          type: 'setWhere',
          field,
          key: chip.key,
          ...(where !== undefined ? { where } : {}),
        }),
      onAnotherPlace: () => {
        const key = nextPlaceKey(state, field, type);
        dispatch({ type: 'select', field, key, value: { type } });
        return `${field}:${key}`;
      },
    };
  });
}

/** Deselect a type in a located field — every place it was said of. */
export function deselectEveryPlace(
  state: ReportSheetState,
  field: LocatedFieldKey,
  type: string,
  dispatch: (action: SheetAction) => void,
): void {
  for (const key of chipKeysOfType(state, field, type)) dispatch({ type: 'deselect', field, key });
}

/** What a chip's mark says: the first place's sector (or ◆ / ◇), and how many more places it has. */
export function whereMarkText(
  state: ReportSheetState,
  field: LocatedFieldKey,
  type: string,
): string {
  const wheres = selectedChips(state, field)
    .filter((c) => (c.value as { type: string }).type === type)
    .map((c) => (c.value as { where?: Where }).where);
  const [first] = wheres;
  const base = first?.sector ? `◆ ${first.sector}` : first ? '◆' : '◇';
  return wheres.length > 1 ? `${base} +${wheres.length - 1}` : base;
}
