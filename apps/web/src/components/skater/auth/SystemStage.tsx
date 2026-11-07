import type { ReactNode } from 'react';
import logoBlack from '@/assets/gli-black-duotone.svg';
import logoWhite from '@/assets/gli-white-duotone.svg';
import { cn } from '@/lib/utils';
import { RegionBackdrop, RegionCredit } from '../RegionBackdrop';

/**
 * A bare screen outside the skater shell (row 8): the region as the ground, the logo where the top
 * bar keeps it, the credit in the corner, and one column in the middle. The header and footer rows
 * are the same height so the column centers on the canvas, as the boards draw it.
 *
 * `data-surface` states the surface here because these routes sit outside `SkaterShell`. The corners
 * come after the column in the DOM, so the tab order runs through the form first.
 */
export function SystemStage({ corner, children }: { corner?: ReactNode; children: ReactNode }) {
  return (
    <div
      data-surface="skater"
      className="relative isolate grid min-h-dvh grid-rows-[3.5rem_1fr_minmax(3.5rem,auto)] bg-bg font-(family-name:--family-sans) text-fg"
    >
      <RegionBackdrop className="fixed -z-10" />
      <main className="row-start-2 flex min-w-0 items-center justify-center px-4 py-2">
        {children}
      </main>
      <div className="row-start-1 flex items-center px-bar-x">
        <img
          src={logoWhite}
          alt="Gli"
          className="hidden h-[1.375rem] [:root:not([data-mode])_&]:[@media(prefers-color-scheme:dark)]:block [:root[data-mode=dark]_&]:block"
        />
        <img
          src={logoBlack}
          alt="Gli"
          className="hidden h-[1.375rem] [:root:not([data-mode])_&]:[@media(prefers-color-scheme:light)]:block [:root[data-mode=light]_&]:block"
        />
      </div>
      <div className="row-start-3 flex flex-wrap items-end justify-between gap-2 px-bar-x pb-[1.375rem]">
        <div>{corner}</div>
        <RegionCredit />
      </div>
    </div>
  );
}

/**
 * The form on the stage: one plain column on the panel ground, a hairline around it. Square — only
 * what you can press rounds. `ph-no-capture` because everything inside is someone's email, name, or
 * date of birth, and the flows report through typed events instead (D240).
 */
export function SystemCard({
  wide = false,
  foot,
  children,
}: {
  /** The profile form's width, for its three fields and the acknowledgment. */
  wide?: boolean;
  /** The card's last row, under a hairline. */
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-slot="system-card"
      className={cn(
        'ph-no-capture w-full max-w-[27.5rem] border border-line2 border-solid bg-bg shadow-[0_18px_48px_var(--shade)]',
        wide && 'max-w-[30rem]',
      )}
    >
      <div className="flex flex-col gap-[1.375rem] px-[2.25rem] py-[2rem]">{children}</div>
      {foot != null && (
        <div className="flex items-center justify-between gap-3 border-line border-t border-solid px-[2.25rem] py-[1rem] text-[0.8125rem] text-fg2 leading-[1.4]">
          {foot}
        </div>
      )}
    </section>
  );
}

/** The card's heading: kicker (and a step count), the display line, the lede. */
export function SystemCardHead({
  kicker,
  step,
  title,
  children,
}: {
  kicker: string;
  /** "1 / 2", in mono, at the kicker row's right. */
  step?: string;
  title: string;
  /** The lede. */
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-heading">
      <div className="flex items-center">
        <span className="font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
          {kicker}
        </span>
        {step && (
          <span className="ml-auto font-(family-name:--family-mono) font-medium text-fg3 text-kick leading-none">
            {step}
          </span>
        )}
      </div>
      <h1 className="font-semibold text-disp text-fg uppercase leading-[1.1] tracking-disp">
        {title}
      </h1>
      <p className="text-fg2 text-pretty text-row leading-body">{children}</p>
    </div>
  );
}

/**
 * A line that isn't any one field's: amber square, then the words. `role="alert"`, because it only
 * ever appears after someone tried something.
 */
export function FormLine({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-[0.625rem] text-[0.8125rem] text-fg1 leading-[1.45]"
    >
      <i aria-hidden="true" className="mt-[0.3125rem] size-2 flex-none bg-warn" />
      <span>{children}</span>
    </p>
  );
}
