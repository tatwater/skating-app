import type { ComponentProps, ReactNode } from 'react';

import { Note, Quote } from '@/components/kit/note';
import { PersonByline } from '@/components/kit/person-lockup';
import { Section } from '@/components/kit/section-slug';
import { cn } from '@/lib/utils';

import { dayTime } from '../handlers/Flag/flagFormat';
import {
  appRuleOf,
  flagsInOrder,
  liveFlags,
  occurrenceLine,
  reasonsOf,
  standingMeta,
} from '../handlers/Flag/flagModel';
import type { FlagMember, FlagTarget, HazardSubjectData } from '../handlers/Flag/flagTypes';
import { REASON_HEAD, FLAG_WORDS as W } from '../handlers/Flag/flagWords';
import { countedLike, isWhole, ListCutLine, type ListTotal, listCount } from './listCut';

/**
 * **The flags on an item** (boards 2.1, 2.6, 2.7): each flagger's own words as a quote, the flagger
 * under it as a byline — face, real name, @handle, standing and points — and when. A flag the app
 * filed (the hazard vote's "never existed", the contradiction check, the unhelpful rating) has no
 * byline and no made-up person: it says what filed it, and how many times it has recurred.
 *
 * - **One flag**: the section's rule ends in when it was filed (2.1). **Several**: the rule ends in
 *   their count, and each byline carries its own time.
 * - **The reason** stands over a flag only when the item holds more than one — one reason is the pane
 *   head's to say, and a header never repeats what the block shows.
 * - Imported by every handler that decides a flag (Flag, Photo).
 */

export type FlagBlockProps = Omit<ComponentProps<'section'>, 'title' | 'children'> & {
  flags: readonly FlagMember[];
  /**
   * The item's own count of its flags and whether the read cut the list short (`flagsCut`): past a
   * page the rule ends in the item's count and a line says how many of how many are shown.
   */
  total: ListTotal;
  /** What was flagged: names an app flag's rule. */
  targetType: FlagTarget['targetType'];
  now: number;
  timeZone?: string;
  /** More under the flags in the same block (2.1's *Also on this report*). */
  children?: ReactNode;
  /**
   * Under a sub-head of the subject's own (2.6's *The flag*, under the skater's card): no section
   * slug, and each byline carries its time.
   */
  bare?: boolean;
  /** For the contradiction check's flag: how many of their reports it counted. */
  counted?: { count: number; capped: boolean } | null;
  /** For the hazard vote's flag: the hazard's type, so the rule names the verdict as its votes do. */
  hazardType?: HazardSubjectData['type'];
};

export function FlagBlock({
  flags,
  total,
  targetType,
  now,
  timeZone,
  children,
  bare = false,
  counted = null,
  hazardType,
  className,
  ...props
}: FlagBlockProps) {
  const ordered = flagsInOrder(liveFlags(flags));
  const many = ordered.length > 1;
  const showReason = reasonsOf(ordered).length > 1;
  const only = ordered[0];
  const shown = countedLike(flags);
  const whole = isWhole(shown, total);
  const cutLine = <ListCutLine members={flags} total={total} noun="flags" />;
  const list = (
    <ol className="m-0 flex list-none flex-col gap-(--space-4) p-0">
      {ordered.map((flag) => (
        <li
          key={flag.flagId}
          data-slot="flag-member"
          data-auto={flag.autoFiled ? '' : undefined}
          className="flex min-w-0 flex-col gap-(--space-2)"
        >
          {showReason && (
            <span
              data-slot="flag-reason"
              className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase"
            >
              {REASON_HEAD[flag.reason]}
            </span>
          )}
          {flag.autoFiled ? (
            <AppFlag
              flag={flag}
              targetType={targetType}
              now={now}
              counted={counted}
              hazardType={hazardType}
            />
          ) : (
            <PersonFlag flag={flag} many={many || bare} timeZone={timeZone} />
          )}
        </li>
      ))}
    </ol>
  );
  if (bare) {
    return (
      <section
        data-slot="flag-block"
        className={cn('flex min-w-0 flex-col gap-(--space-2)', className)}
        {...props}
      >
        {list}
        {cutLine}
        {children}
      </section>
    );
  }
  return (
    <Section
      data-slot="flag-block"
      level={3}
      title={many || !whole ? W.flags : W.flag}
      {...(many || !whole
        ? { count: listCount(shown, total) }
        : only !== undefined && {
            end: (
              <span
                data-slot="flag-when"
                className="font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase"
              >
                {dayTime(only.filedAt, timeZone)}
              </span>
            ),
          })}
      className={cn('gap-heading', className)}
      {...props}
    >
      {list}
      {cutLine}
      {children}
    </Section>
  );
}

function PersonFlag({
  flag,
  many,
  timeZone,
}: {
  flag: FlagMember;
  many: boolean;
  timeZone: string | undefined;
}) {
  const when = dayTime(flag.filedAt, timeZone);
  const standing = standingMeta(flag.filer);
  const meta = many ? [standing, when].filter((x) => x !== null).join(' · ') : standing;
  return (
    <>
      {flag.note !== null && flag.note.trim() !== '' && (
        <Quote data-slot="flag-quote">{flag.note}</Quote>
      )}
      {flag.filer === null || flag.filer.deleted ? (
        <span data-slot="flag-filer-gone" className="text-row leading-list text-fg3">
          {W.goneFiler}
          {many && <span className="ms-(--space-2) text-fg3">· {when}</span>}
        </span>
      ) : (
        <div data-slot="flag-byline">
          <PersonByline
            // A narrow pane: the standing wraps under the name rather than over the handle.
            className="flex-wrap gap-y-(--space-1)"
            name={flag.filer.displayName}
            {...(flag.filer.username !== '' && { handle: flag.filer.username })}
            {...(meta !== null && meta !== '' && { meta })}
          />
        </div>
      )}
    </>
  );
}

/** Whether an app flag's note is the rule's own count (the hazard vote's), the only one drawn. */
export function appNoteShown(
  flag: Pick<FlagMember, 'reason' | 'note' | 'autoFiled'>,
  targetType: FlagTarget['targetType'],
): boolean {
  return (
    flag.autoFiled &&
    flag.reason === 'unsafe_false_report' &&
    targetType === 'hazard' &&
    flag.note !== null &&
    flag.note.trim() !== ''
  );
}

function AppFlag({
  flag,
  targetType,
  now,
  counted,
  hazardType,
}: {
  flag: FlagMember;
  targetType: FlagTarget['targetType'];
  now: number;
  counted: { count: number; capped: boolean } | null;
  hazardType: HazardSubjectData['type'] | undefined;
}) {
  const occurrences = occurrenceLine(flag, now);
  return (
    <Note data-slot="flag-app">
      <strong>{W.filedByApp}</strong>
      <span className="block">{appRuleOf(flag.reason, targetType, counted, hazardType)}</span>
      {/* Only the hazard vote's note is the rule's own count, as it filed it ("2 skaters reported that
          nothing was ever at this pin" — each person's latest vote, the reporter's left out). The
          contradiction check's note is fixed server prose and the unhelpful rating writes none: no
          other app note is drawn. */}
      {appNoteShown(flag, targetType) && flag.note !== null && (
        <span data-slot="flag-app-note" className="block">
          {flag.note}
        </span>
      )}
      {occurrences !== null && (
        <span data-slot="flag-occurrences" className="block text-fg3">
          {occurrences}
        </span>
      )}
    </Note>
  );
}
