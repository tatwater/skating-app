import { RESTRICTIONS } from '@skating/core';
import type { ComponentProps, ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { FactList } from '@/components/kit/fact-list';
import { PersonLockup } from '@/components/kit/person-lockup';
import { Section } from '@/components/kit/section-slug';
import { TRUST_WORDS } from '../../people/person/personModel';
import { countWords, dayLabel } from '../handlers/Flag/flagFormat';
import { untilWords } from '../handlers/Flag/flagModel';
import type { AuthorBlockData } from '../handlers/Flag/flagTypes';
import { FLAG_WORDS as W } from '../handlers/Flag/flagWords';

/**
 * **Whose content it is** (board 2.1's *Author*, 2.7's): the person by their real name, their
 * standing — a suspension or ban with when it lifts and, on a line of its own, who set it — their
 * reports and how many a moderator found contradicted, their trust class as a tag (never a raw
 * score), their open flags, and what they may post. A count the server couldn't know says so, never
 * a zero. Nothing admin-only is shown here, so nothing is hidden from a moderator.
 *
 * Imported by every handler that names an author (Flag, Photo); a flag on a person leads with it.
 */

export type AuthorBlockProps = Omit<ComponentProps<'section'>, 'title' | 'children'> & {
  author: AuthorBlockData;
  /** The section's title: *Author* (whose content), or *The person* (a flag on them). */
  title?: string;
  /** How many open flags this item itself holds — "1 · this one". */
  ownFlags?: number;
  timeZone?: string;
  /** More under the rows (the head's link on a person flag, a note). */
  children?: ReactNode;
};

const POSTS = ['reports', 'hazards', 'comments'] as const;

/** What the person may post, from their restrictions: "reports · hazards · comments", or "Nothing". */
export function canPostWords(restrictions: readonly string[]): string {
  const open = POSTS.filter((p) => !restrictions.includes(p));
  return open.length === 0 ? W.postsNothing : open.join(' · ');
}

/** "14 · 2 contradicted", or *Not recorded yet* when the server couldn't count them. */
export function reportsWords(author: Pick<AuthorBlockData, 'reports' | 'contradicted'>): string {
  if (author.reports === null) return W.unknownCount;
  const base = countWords(author.reports);
  if (author.contradicted === null || author.contradicted.count === 0) return base;
  return `${base} · ${W.contradicted(countWords(author.contradicted))}`;
}

/** "1 · this one" when the only open flag is this item's; else the count. */
export function openFlagsWords(openFlags: AuthorBlockData['openFlags'], ownFlags: number): string {
  if (openFlags === null) return W.unknownCount;
  const n = countWords(openFlags);
  return !openFlags.capped && openFlags.count === ownFlags && ownFlags > 0
    ? `${n} · ${W.thisOne}`
    : n;
}

/**
 * Board 2.1's line under the author: their earlier flags a moderator actioned, and when the latest
 * was ("An earlier flag on them was actioned on Sat 10 Oct"); a count the read stopped short on is a
 * floor ("50+"). Nothing when there were none.
 */
export function priorActionedWords(
  prior: AuthorBlockData['priorActioned'],
  timeZone?: string,
): string | null {
  if (prior.count === 0 && !prior.capped) return null;
  const day = prior.lastAt === null ? null : dayLabel(prior.lastAt, timeZone);
  return W.priorActioned(countWords(prior), prior.count === 1 && !prior.capped, day);
}

const STANDING_TONE = { suspended: 'warn', banned: 'bad' } as const;

export function AuthorBlock({
  author,
  title = W.author,
  ownFlags = 0,
  timeZone,
  children,
  ...props
}: AuthorBlockProps) {
  const { person, standing } = author;
  const gone = person.deleted || standing.status === 'deleted';
  const tone =
    standing.status === 'suspended' || standing.status === 'banned'
      ? STANDING_TONE[standing.status]
      : null;
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: W.user,
      value: gone ? (
        <span className="text-fg3">{W.departed}</span>
      ) : (
        <PersonLockup
          size="md"
          name={person.displayName}
          {...(person.username !== '' && { handle: person.username })}
        />
      ),
    },
    {
      label: W.status,
      value: (
        <span data-slot="author-standing" className="flex flex-col gap-(--space-1_5)">
          <span className="flex flex-wrap items-center gap-x-(--space-2) gap-y-(--space-1)">
            {tone === null ? (
              W.standing[standing.status]
            ) : (
              <Badge variant="outline" tone={tone}>
                {W.standing[standing.status]}
              </Badge>
            )}
            {standing.until !== null && (
              <span className="text-fg2">{untilWords(standing.until, timeZone)}</span>
            )}
          </span>
          {standing.by !== null && !standing.by.deleted && (
            <PersonLockup
              data-slot="author-standing-by"
              name={standing.by.displayName}
              {...(standing.by.username !== '' && { handle: standing.by.username })}
            />
          )}
        </span>
      ),
    },
    { label: W.reports, value: reportsWords(author) },
  ];
  if (person.trustClass !== null) {
    rows.push({
      label: W.trust,
      value: (
        <Badge data-slot="author-trust" variant="outline">
          {TRUST_WORDS[person.trustClass]}
        </Badge>
      ),
    });
  }
  rows.push({ label: W.openFlags, value: openFlagsWords(author.openFlags, ownFlags) });
  if (!gone) rows.push({ label: W.canPost, value: canPostWords(author.restrictions) });
  const prior = priorActionedWords(author.priorActioned, timeZone);
  return (
    <Section data-slot="author-block" level={3} title={title} {...props}>
      <FactList rows={rows} />
      {prior !== null && (
        <span data-slot="author-prior" className="text-assist leading-list text-fg3">
          {prior}
        </span>
      )}
      {children}
    </Section>
  );
}

/** Every restriction a person can carry, for a test that the block names each posting right. */
export const KNOWN_RESTRICTIONS = RESTRICTIONS;
