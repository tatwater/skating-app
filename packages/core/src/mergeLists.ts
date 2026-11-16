/**
 * **What a merge does with a body's moderator-held lists** (B01-3g, Greptile on #130): the survivor
 * holds the union of every merged body's pinned towns, aliases and reference links — nothing a
 * moderator set is dropped. A union that would pass a list's cap is a refusal, never a truncation: a
 * moderator clears some first. The merge, its automated callers and the page that offers a merge all
 * ask this one function, so a merge is never offered that the write would refuse.
 *
 * A body's weather sample points are not carried: each is a point on that body's own outline, and
 * the write that sets them refuses a point off the outline, so the loser's grid means nothing on the
 * survivor's shape. The survivor keeps its own grid; the loser's stays on its tombstone.
 */

import { bodyLabel } from './bodyCompare';
import { MAX_REFERENCE_LINKS } from './referenceLinks';

/** The most towns a moderator may pin one body in. */
export const MAX_MODERATOR_TOWNS = 8;
/** The most aliases a moderator may give one body. */
export const MAX_MODERATOR_ALIASES = 20;

/** One body's side of a merge: its name and its moderator-held lists. */
export interface MergeListSide {
  name: string;
  moderatorTownKeys?: readonly string[];
  moderatorAliases?: readonly string[];
  referenceLinks?: readonly { label: string; url: string }[];
}

export interface MergedLists {
  pins: string[];
  aliases: string[];
  links: { label: string; url: string }[];
  /** Why the merge can't hold the union, in a sentence a moderator can act on; `null` when it can. */
  refusal: string | null;
}

/** The body as the duplicate card names it — `(unnamed)` for a body with no name. */
const quoted = (name: string) => `“${bodyLabel({ name })}”`;

/**
 * The survivor's lists after merging `others` into it — each the union, the survivor's own first and
 * kept exactly as it stands (the links writer allows two links to one URL, and neither is dropped) —
 * or the refusal when any union passes its cap. An alias is new when no alias already held and not
 * the survivor's name has it, case aside (`normalizeModeratorAliases`' rule); a link when its URL is.
 */
export function mergedModeratorLists(
  survivor: MergeListSide,
  others: readonly MergeListSide[],
): MergedLists {
  const pins = [...new Set([survivor, ...others].flatMap((b) => b.moderatorTownKeys ?? []))];
  const aliases = [...(survivor.moderatorAliases ?? [])];
  const aliasKey = (alias: string) => alias.toLocaleLowerCase('en-US');
  const aliasKeys = new Set([aliasKey(survivor.name.trim()), ...aliases.map(aliasKey)]);
  for (const alias of others.flatMap((b) => b.moderatorAliases ?? [])) {
    const key = aliasKey(alias);
    if (aliasKeys.has(key)) continue;
    aliasKeys.add(key);
    aliases.push(alias);
  }
  const links = (survivor.referenceLinks ?? []).map((l) => ({ label: l.label, url: l.url }));
  const urls = new Set(links.map((l) => l.url));
  for (const link of others.flatMap((b) => b.referenceLinks ?? [])) {
    if (urls.has(link.url)) continue;
    urls.add(link.url);
    links.push({ label: link.label, url: link.url });
  }
  const over = (what: string, n: number, max: number) =>
    `Can't merge into ${quoted(survivor.name)}: together the bodies hold ${n} ${what}, more than the ${max} one body can. Clear some first.`;
  const refusal =
    pins.length > MAX_MODERATOR_TOWNS
      ? over('pinned towns', pins.length, MAX_MODERATOR_TOWNS)
      : aliases.length > MAX_MODERATOR_ALIASES
        ? over('moderator aliases', aliases.length, MAX_MODERATOR_ALIASES)
        : links.length > MAX_REFERENCE_LINKS
          ? over('reference links', links.length, MAX_REFERENCE_LINKS)
          : null;
  return { pins, aliases, links, refusal };
}
