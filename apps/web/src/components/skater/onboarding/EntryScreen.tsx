import { ONBOARDING_COPY, onboardingStepLabel } from '@skating/core';
import { createContext, type ReactNode, useContext, useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '../../kit/button';
import { StageLogo } from '../auth/SystemStage';
import { RegionBackdrop, RegionCredit } from '../RegionBackdrop';
import { INK_PRIMARY } from '../styles';

/**
 * **One step of the way in, on a desk or a phone** (rows 10 and 11, B03 §9.6). On a desk, the
 * system screens' stage: the region as the ground, the logo top left, the credit bottom right, and
 * one card in the middle — head, body, actions, then *Signed in as … · Sign out* under a hairline.
 * Below `md` the same step is the whole phone screen: a bar with the logo and *Sign out*, the head
 * and body scrolling under it, and the actions pinned under the thumb.
 *
 * **The switch is a container query, not a media query**, at the same 48 rem edge as `md:`. In the
 * app the container is the viewport's width, so the two agree; a story can draw the phone board at
 * 390 px inside a wide canvas and get the phone, which a media query would never give it. The
 * root's height is the screen's: `min-h-dvh` in the app (a story pins it with `className`).
 *
 * The phone's scrolling body is offered to the step's content (`useEntryScroller`): the terms are
 * read on the page itself there, so their reader measures this scroller instead of its own window.
 */

/** The card's width on a desk, per step, as the boards draw it. */
const WIDTH = {
  account: 'max-w-[30rem]',
  terms: 'max-w-[40rem]',
  receipt: 'max-w-[32.5rem]',
  questions: 'max-w-[35rem]',
  home: 'max-w-[30rem]',
  profile: 'max-w-[32.5rem]',
  season: 'max-w-[30rem]',
} as const;

export type EntryWidth = keyof typeof WIDTH;

const ScrollerContext = createContext<HTMLElement | null>(null);

/** The phone's scrolling body (or `null` before it mounts, and on a desk it never scrolls). */
export function useEntryScroller(): HTMLElement | null {
  return useContext(ScrollerContext);
}

export interface EntryScreenProps {
  width: EntryWidth;
  /** The step's head (`EntryHead`). */
  head: ReactNode;
  /** The step's body: fields, the reader, a question. */
  children?: ReactNode;
  /** The primary and its neighbors: in the card on a desk, pinned at the foot on a phone. */
  actions: ReactNode;
  /** Whose account this is, for *Signed in as*; `null` leaves the address out. */
  email: string | null;
  onSignOut: () => void;
  /**
   * The desk card's foot (*Signed in as … · Sign out*). The season card has none: its own second
   * button is the way out. The phone's bar keeps *Sign out* either way.
   */
  foot?: boolean;
  /** How far the terms have been read, 0–1: the hairline under the phone's bar. */
  progress?: number | null;
  className?: string;
}

export function EntryScreen({
  width,
  head,
  children,
  actions,
  email,
  onSignOut,
  foot = true,
  progress = null,
  className,
}: EntryScreenProps) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  return (
    <div
      data-surface="skater"
      data-slot="entry-screen"
      className={cn(
        '@container/entry relative isolate flex min-h-dvh flex-col bg-bg font-(family-name:--family-sans) text-fg',
        className,
      )}
    >
      <div className="grid flex-1 grid-rows-[3.5rem_1fr_minmax(3.5rem,auto)] @max-[48rem]/entry:absolute @max-[48rem]/entry:inset-0 @max-[48rem]/entry:flex @max-[48rem]/entry:flex-col">
        <RegionBackdrop className="fixed -z-10 @max-[48rem]/entry:hidden" />
        {/* The phone's bar: the logo, and the way out. */}
        <div
          data-slot="entry-phone-bar"
          className="relative hidden h-[3.25rem] flex-none items-center justify-between border-0 border-line border-b border-solid pr-3 pl-4 @max-[48rem]/entry:flex"
        >
          <StageLogo className="h-5" />
          <Button size="sm" onClick={onSignOut} data-attr="entry-sign-out">
            {ONBOARDING_COPY.foot.signOut}
          </Button>
          {progress !== null && (
            <span
              data-slot="entry-read-progress"
              aria-hidden="true"
              className="absolute inset-x-0 -bottom-px h-0.5 bg-line"
            >
              <span
                className="block h-full bg-fg1"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }}
              />
            </span>
          )}
        </div>
        <main className="row-start-2 flex min-w-0 items-center justify-center px-4 py-6 @max-[48rem]/entry:min-h-0 @max-[48rem]/entry:flex-1 @max-[48rem]/entry:items-stretch @max-[48rem]/entry:p-0">
          <section
            data-slot="entry-card"
            className={cn(
              'flex w-full flex-col border border-line2 border-solid bg-bg shadow-[0_18px_48px_var(--shade)]',
              '@max-[48rem]/entry:max-w-none @max-[48rem]/entry:border-0 @max-[48rem]/entry:shadow-none',
              WIDTH[width],
            )}
          >
            <div
              ref={setScroller}
              data-slot="entry-body"
              className="flex flex-col gap-5 px-9 pt-8 @max-[48rem]/entry:min-h-0 @max-[48rem]/entry:flex-1 @max-[48rem]/entry:overflow-y-auto @max-[48rem]/entry:px-5 @max-[48rem]/entry:pt-6 @max-[48rem]/entry:pb-6"
            >
              <ScrollerContext.Provider value={scroller}>
                {head}
                {children}
              </ScrollerContext.Provider>
            </div>
            <div
              data-slot="entry-actions"
              className="flex flex-col gap-3 px-9 pt-5 pb-8 @max-[48rem]/entry:flex-none @max-[48rem]/entry:border-0 @max-[48rem]/entry:border-line @max-[48rem]/entry:border-t @max-[48rem]/entry:border-solid @max-[48rem]/entry:px-4 @max-[48rem]/entry:pt-3.5 @max-[48rem]/entry:pb-[1.125rem]"
            >
              {actions}
            </div>
            {foot && (
              <div
                data-slot="entry-foot"
                className="flex items-center justify-between gap-3 border-0 border-line border-t border-solid px-9 py-4 text-[0.8125rem] text-fg2 leading-[1.4] @max-[48rem]/entry:hidden"
              >
                <span className="ph-no-capture min-w-0 truncate">
                  {ONBOARDING_COPY.foot.signedInAs}{' '}
                  {email !== null && <span className="text-fg1">{email}</span>}
                </span>
                <Button size="sm" onClick={onSignOut} data-attr="entry-sign-out">
                  {ONBOARDING_COPY.foot.signOut}
                </Button>
              </div>
            )}
          </section>
        </main>
        <div className="row-start-3 flex flex-wrap items-end justify-end gap-2 px-bar-x pb-[1.375rem] @max-[48rem]/entry:hidden">
          <RegionCredit />
        </div>
        <div className="row-start-1 flex items-center px-bar-x @max-[48rem]/entry:hidden">
          <StageLogo />
        </div>
      </div>
    </div>
  );
}

/**
 * A step's head: the kicker (and, for an account new this session, *N of 5*), the display line,
 * the lede. A question has neither line: only its kicker row.
 */
export function EntryHead({
  kicker,
  step,
  title,
  children,
}: {
  kicker: string;
  /** The step's place, shown only when the account is new this session (§9.3). */
  step?: number | null;
  title?: string;
  /** The lede. */
  children?: ReactNode;
}) {
  return (
    <div data-slot="entry-head" className="flex flex-col gap-3">
      <div className="flex items-center">
        <span className="font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
          {kicker}
        </span>
        {step != null && (
          <span
            data-slot="entry-step"
            className="ml-auto font-(family-name:--family-mono) font-medium text-fg3 text-kick leading-none"
          >
            {onboardingStepLabel(step)}
          </span>
        )}
      </div>
      {title !== undefined && (
        <h1 className="m-0 text-balance font-semibold text-disp text-fg uppercase leading-[1.1] tracking-disp">
          {title}
        </h1>
      )}
      {children != null && (
        <div className="text-fg2 text-pretty text-row leading-body [&_b]:font-medium [&_b]:text-fg1">
          {children}
        </div>
      )}
    </div>
  );
}

/** A primary's height on these screens, full width (`.btn.pri.wide`): taller under a thumb. */
export const WIDE = 'h-[2.625rem] w-full @max-[48rem]/entry:h-[2.875rem]';

/**
 * The skater surface's solid-ink primary (`INK_PRIMARY`), and its inert look while it can't run
 * yet (`.btn.off`: the raised ground, a hairline, the faint ink) — the ink would otherwise hold
 * over the kit's disabled face, and a locked *Record acceptance* would look pressable.
 */
export const ENTRY_PRIMARY = cn(
  INK_PRIMARY,
  'data-disabled:bg-raise data-disabled:text-fg3 data-disabled:inset-ring data-disabled:inset-ring-line',
);
