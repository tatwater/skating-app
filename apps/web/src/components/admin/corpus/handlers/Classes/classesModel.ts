import {
  type ClaimSource,
  type WaterBodyClass,
  waterBodyClassLabel,
  waterBodyDisplayName,
} from '@skating/core';

import { CATALOG_TAGS } from '../../../body/tabs/names/namesModel';
import type { CorpusItemOf } from '../../corpusTypes';
import { acresText, raisedAgainWords, TASK_WORDS } from '../taskFacts';
import { CLASS_WORDS as W } from './classWords';

/**
 * **Board 4.3's facts, from the item alone** — pure, so every rule is tested without a page. The
 * item is `corpusTasks.item`'s Class conflicts view; every verb is read from its `can`, and the
 * catalogs' claims, stored only from the next campaign (`claims: null` before it), read *not
 * recorded* — the ladder still draws, without its catalog columns.
 */

export type ClassesItem = CorpusItemOf<'classConflicts'>;
export type ClassRung = ClassesItem['ladder'][number];

export type ClassLever = {
  verb: 'keepClass' | 'setClass';
  bodyClass: WaterBodyClass;
  /** The bar's button, naming the pick. */
  label: string;
};

const open = (item: Pick<ClassesItem, 'decided'>) => item.decided === null;

export const verbOf = (rung: Pick<ClassRung, 'now'>): ClassLever['verb'] =>
  rung.now ? 'keepClass' : 'setClass';

/** The rung can be applied: the task is open and the item's `can` allows its verb. */
export function pickable(item: Pick<ClassesItem, 'can' | 'decided'>, rung: ClassRung): boolean {
  return open(item) && item.can[verbOf(rung)] === null;
}

/** The pick a task opens on (Review 11 rule 3): the suggestion, else the class now — each only if it applies. */
export function defaultPick(
  item: Pick<ClassesItem, 'ladder' | 'can' | 'decided'>,
): WaterBodyClass | null {
  const suggested = item.ladder.find((r) => r.suggested && pickable(item, r));
  if (suggested) return suggested.cls;
  return item.ladder.find((r) => r.now && pickable(item, r))?.cls ?? null;
}

/** The lever for a pick, or `null` when it can't be applied (nothing drawn for it). */
export function leverOf(
  item: Pick<ClassesItem, 'ladder' | 'can' | 'decided'>,
  pick: WaterBodyClass | null,
): ClassLever | null {
  const rung = item.ladder.find((r) => r.cls === pick);
  if (rung === undefined || !pickable(item, rung)) return null;
  const label = waterBodyClassLabel(rung.cls);
  return rung.now
    ? { verb: 'keepClass', bodyClass: rung.cls, label: W.keepAs(label) }
    : { verb: 'setClass', bodyClass: rung.cls, label: W.setAs(label) };
}

/** The first refusal among the lane's verbs when no rung can be applied; `null` otherwise or once decided. */
export function refusalSaid(item: Pick<ClassesItem, 'ladder' | 'can' | 'decided'>): string | null {
  if (!open(item) || item.ladder.some((r) => pickable(item, r))) return null;
  for (const verb of ['keepClass', 'setClass'] as const) {
    const answer = item.can[verb];
    if (typeof answer === 'string') return answer;
  }
  return null;
}

/** The catalogs' columns, in the board's order (NHD, 3DHP, OSM, then the rest). */
const COLUMN_ORDER: readonly ClaimSource[] = ['nhd', '3dhp', 'osm', 'gnis', 'name', 'user'];

/** The ladder's catalog columns: each catalog with a recorded claim. None before the campaign. */
export function catalogColumns(item: Pick<ClassesItem, 'claims' | 'ladder'>): ClaimSource[] {
  if (item.claims === null) return [];
  const seen = new Set<ClaimSource>([
    ...item.claims.map((c) => c.source),
    ...item.ladder.flatMap((r) => Object.keys(r.byCatalog) as ClaimSource[]),
  ]);
  return COLUMN_ORDER.filter((s) => seen.has(s));
}

export const tagOf = (source: ClaimSource): string => CATALOG_TAGS[source];

/** A catalog's token as the ladder marks it: its own words, without the catalog's prefix. */
export function tokenText(token: string): string {
  const colon = token.indexOf(':');
  return colon < 0 ? token : token.slice(colon + 1);
}

/** Each catalog's mark on a rung, keyed by catalog. */
export function rungMarks(rung: ClassRung): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const [source, token] of Object.entries(rung.byCatalog)) {
    if (token !== undefined) out[source] = tokenText(token);
  }
  return out;
}

/** *The catalogs*: one row per claim (“Wetland · fcode=46600 · 7 ac”), or none when not recorded. */
export function catalogRows(
  claims: ClassesItem['claims'],
): { label: string; value: string; key: string }[] | null {
  if (claims === null) return null;
  return claims.map((c, i) => {
    const parts = [
      waterBodyClassLabel(c.cls),
      c.token === null ? null : tokenText(c.token),
      c.acres === null ? null : W.acres(acresText(c.acres)),
    ].filter((p): p is string => p !== null);
    if (c.token === null && c.acres === null) parts.push(W.codeNotRecorded);
    return { key: `${c.source}:${i}`, label: tagOf(c.source), value: parts.join(' · ') };
  });
}

/** The pane head's line: “Unnamed water · Groton, VT · 5 ac”. */
export function headLine(body: ClassesItem['body']): string {
  return [
    waterBodyDisplayName(body.name),
    body.place,
    body.acres === null ? null : W.acres(acresText(body.acres)),
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
}

/** *Depth*: the deepest measure on file ("2.4 m max", else "mean") and where it came from, or none. */
export function depthWords(depth: ClassesItem['depth']): string {
  if (depth === null) return W.noneOnFile;
  const figure = W.meters(depth.meters.toLocaleString('en-US', { maximumFractionDigits: 1 }));
  const m = depth.measure === undefined ? figure : `${figure} ${W.measure[depth.measure]}`;
  return depth.source === '' ? m : `${m} · ${depth.source}`;
}

/** *Name*: the body's name, or that no catalog names it. */
export const nameWords = (body: ClassesItem['body']): string =>
  body.name.trim() === '' ? W.noName : body.name;

/** *Nearest*: the first neighbor the geometry facts name; *not computed yet* before they are. */
export const nearestWords = (neighbors: ClassesItem['neighbors']): string =>
  neighbors === null
    ? TASK_WORDS.notComputed
    : neighbors[0] === undefined
      ? W.noneOnFile
      : waterBodyDisplayName(neighbors[0].name);

/** The *asked again* note (D305): a catalog's class changed since it was settled. */
export const raisedAgainNote = (item: Pick<ClassesItem, 'raisedAgain'>, timeZone?: string) =>
  raisedAgainWords(item.raisedAgain, W.classChanged, timeZone);

export const NOT_RECORDED = TASK_WORDS.notRecorded;
