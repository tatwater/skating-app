import { type ClaimSource, waterBodyClassLabel } from '@skating/core';

import { CATALOG_NAMES, CATALOG_TAGS } from '../../../body/tabs/names/namesModel';
import type { CorpusItemOf } from '../../corpusTypes';
import { acresText, raisedAgainWords, TASK_WORDS } from '../taskFacts';
import { NAME_WORDS as W } from './nameWords';

/**
 * **Board 4.2's facts, from the item alone** — pure, so every rule is tested without a page. The
 * item is `corpusTasks.item`'s Name conflicts view; every verb is read from its `can` (absent: not
 * this lane's; a sentence: refused, never a button; `null`: allowed), and every fact the item
 * holds as *not recorded* is said so, never guessed.
 */

export type NamesItem = CorpusItemOf<'nameConflicts'>;
export type NameChoice = NamesItem['names'][number];

/** A choice's value as the write takes it: the shown name is `'shown'` (a keep), any other its spelling. */
export type NameLever = {
  verb: 'keepName' | 'pickName';
  pick: string;
  /** The bar's button, naming the pick. */
  label: string;
  /** The name the body displays once it lands. */
  name: string;
};

const open = (item: Pick<NamesItem, 'decided'>) => item.decided === null;

/** The verb a choice takes: keeping the shown name, or displaying another. */
export const verbOf = (choice: Pick<NameChoice, 'shown'>): NameLever['verb'] =>
  choice.shown ? 'keepName' : 'pickName';

/** The choice can be applied: the task is open and the item's `can` allows its verb. */
export function pickable(item: Pick<NamesItem, 'can' | 'decided'>, choice: NameChoice): boolean {
  return open(item) && item.can[verbOf(choice)] === null;
}

/**
 * The pick a task opens on (Review 11 rule 3): the suggestion, else the name shown now — each only
 * if it can be applied. In 6a nothing is suggested (D307), so it is the shown name: ⏎ keeps it.
 */
export function defaultPick(item: Pick<NamesItem, 'names' | 'can' | 'decided'>): string | null {
  const suggested = item.names.find((n) => n.suggested && pickable(item, n));
  if (suggested) return suggested.value;
  const shown = item.names.find((n) => n.shown && pickable(item, n));
  return shown?.value ?? null;
}

/** The lever for a pick, or `null` when it can't be applied (nothing drawn for it). */
export function leverOf(
  item: Pick<NamesItem, 'names' | 'can' | 'decided'>,
  pick: string | null,
): NameLever | null {
  const choice = item.names.find((n) => n.value === pick);
  if (choice === undefined || !pickable(item, choice)) return null;
  return choice.shown
    ? { verb: 'keepName', pick: 'shown', label: W.keep(choice.value), name: choice.value }
    : {
        verb: 'pickName',
        pick: choice.value,
        label: W.displayInstead(choice.value),
        name: choice.value,
      };
}

/**
 * The first refusal among the lane's verbs when the item draws no lever at all — said once in the
 * body, so an empty bar is never a mystery. `null` while any choice can be applied, or once decided.
 */
export function refusalSaid(item: Pick<NamesItem, 'names' | 'can' | 'decided'>): string | null {
  if (!open(item) || item.names.some((n) => pickable(item, n))) return null;
  for (const verb of ['keepName', 'pickName'] as const) {
    const answer = item.can[verb];
    if (typeof answer === 'string') return answer;
  }
  return null;
}

/** The catalogs a spelling wears: every one recorded, or the top one alone. */
export function catalogRun(choice: Pick<NameChoice, 'sources' | 'sourcesRecorded'>): ClaimSource[] {
  return choice.sourcesRecorded ? choice.sources : choice.sources.slice(0, 1);
}

export const tagOf = (source: ClaimSource): string => CATALOG_TAGS[source];

/** *From*: the first catalog written out, the rest tagged (“USGS Geographic Names, via NHD and 3DHP”). */
export function fromWords(choice: Pick<NameChoice, 'sources' | 'sourcesRecorded'>): string {
  const [first, ...rest] = catalogRun(choice);
  if (first === undefined) return TASK_WORDS.notRecorded;
  if (rest.length === 0) return CATALOG_NAMES[first];
  return W.via(CATALOG_NAMES[first], rest.map(tagOf).join(W.and));
}

/** *Elsewhere*: how many other listed bodies carry the name (“50+” where the read stopped). */
export function elsewhereWords(namesakes: NameChoice['namesakes']): string {
  if (namesakes.count === 0 && !namesakes.capped) return W.onlyOne;
  return W.othersCarry(`${namesakes.count.toLocaleString('en-US')}${namesakes.capped ? '+' : ''}`);
}

/** The catalogs, not the moderator: who can vouch that the body is one body. */
const CATALOGS: ReadonlySet<ClaimSource> = new Set(['gnis', 'nhd', '3dhp', 'osm']);

/**
 * *Catalogs*: how many catalogs drew the body under any of its names — only when every spelling's
 * catalogs are recorded; before the campaign that records them, *not recorded*.
 */
export function catalogsWords(item: Pick<NamesItem, 'names'>): string {
  if (item.names.length === 0 || item.names.some((n) => !n.sourcesRecorded))
    return TASK_WORDS.notRecorded;
  const all = new Set(item.names.flatMap((n) => n.sources).filter((s) => CATALOGS.has(s)));
  if (all.size < 2) return TASK_WORDS.notRecorded;
  return W.allAgree(all.size);
}

/** The kicker over the body's name: “Auburn, ME · Lake or pond · 2,263 ac”. */
export function bodyLine(body: NamesItem['body']): string {
  return [
    body.place,
    waterBodyClassLabel(body.cls),
    body.acres === null ? null : `${acresText(body.acres)} ac`,
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
}

/** The *asked again* note (D305): a catalog's spelling changed since it was settled. */
export const raisedAgainNote = (item: Pick<NamesItem, 'raisedAgain'>, timeZone?: string) =>
  raisedAgainWords(item.raisedAgain, W.spellingChanged, timeZone);

/**
 * *Once … shows*: what the pick does — the name displayed, every other spelling kept as an alias
 * that search still finds, the choice holding until a catalog's spelling changes (D305), and its
 * undo. A keep says so (“The Basin, as now”).
 */
export function onceRows(
  item: Pick<NamesItem, 'names'>,
  lever: Pick<NameLever, 'verb' | 'name'>,
): { label: string; value: string; strong?: boolean }[] {
  const others = item.names.filter((n) => n.value !== lever.name).map((n) => n.value);
  return [
    lever.verb === 'keepName'
      ? { label: W.displays, value: W.asNow(lever.name) }
      : { label: W.displays, value: lever.name, strong: true },
    ...(others.length > 0 ? [{ label: W.alias, value: W.stillFound(others.join(', ')) }] : []),
    { label: W.campaigns, value: W.holds },
    { label: W.undo, value: W.inHistory },
  ];
}

/** What a reader types into the skater app's search to find the body by its other name. */
export function typedFor(alias: string): string {
  const words = alias.toLowerCase().split(/\s+/).filter(Boolean);
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a), '');
  return longest || alias.toLowerCase();
}
