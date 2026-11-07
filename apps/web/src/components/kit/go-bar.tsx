import type { ComponentProps } from 'react';

import { type GoTarget, useGoMode } from '@/lib/keys';
import { cn } from '@/lib/utils';

import { Kbd } from './kbd';

/**
 * The kit's go bar: what the console shows while go-mode is open (`G` pressed, waiting for a
 * letter). Custom — no primitive. The engine lives in `lib/keys.ts`; this is its one visible
 * piece. Dimming the page and lighting the rail's ice caps are the shell's (it reads
 * `useGoMode().active` too).
 *
 * - **Floats at the bottom center of the console**, the status bar's height plus `space-4_5` up
 *   (44 px on the console), over everything but toasts and sheets (`z-gobar`).
 * - **Ice, because it's a transient mode**: an ice hairline, an ice wash ring and glow, on the
 *   solid plate; the kicker in ice, the keys it names in the bright ink, the rest in `fg2`.
 * - **Says what to do**: "G pressed · Select a nav item by its letter, like I to open Inbox",
 *   the example taken from the first place go-mode can reach, and Esc's cap to leave.
 * - **A live region**: it's always in the page (empty while closed), so a reader hears the line
 *   when go-mode opens. It fades in on `duration-fast` — instant under reduced motion.
 *
 * It reads go-mode from the nearest `KeysProvider`; a static board passes `open` and `example`.
 */
type GoBarProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** Force the bar open or closed (a static board); otherwise go-mode decides. */
  open?: boolean;
  /** The place the line uses as its example; otherwise the first go target. */
  example?: Pick<GoTarget, 'key' | 'label'>;
};

function GoBar({ open, example, className, style, ...props }: GoBarProps) {
  const go = useGoMode();
  const shown = open ?? go.active;
  const sample = example ?? go.targets[0];
  return (
    <div
      role="status"
      data-slot="go-bar"
      data-open={shown ? '' : undefined}
      className={cn(
        'pointer-events-none absolute left-1/2 z-(--z-gobar) -translate-x-1/2',
        'flex h-(--space-8) items-center gap-(--space-3) px-(--space-3_5)',
        'border-(length:--stroke-hair) border-solid border-acc bg-plate-solid',
        // The ring and the glow: the mock's 3 px wash ring and 22 px glow (drawing values, px).
        'shadow-[0_0_0_3px_var(--acc-wash),0_0_22px_var(--acc-glow)]',
        'font-(family-name:--family-sans) text-assist leading-none whitespace-nowrap text-fg2',
        'invisible opacity-0 transition-[opacity,visibility] duration-(--duration-fast) ease-standard',
        'data-open:visible data-open:opacity-100',
        className,
      )}
      // Inline, not a class: Tailwind reads the `_` in `space-4_5` inside an arbitrary calc() as a
      // space, so the class would never be generated.
      style={{ bottom: 'calc(var(--size-status) + var(--space-4_5))', ...style }}
      {...props}
    >
      {shown && (
        <>
          <span
            data-slot="go-bar-kicker"
            className="text-kick leading-none font-semibold tracking-kick text-acc uppercase"
          >
            Go
          </span>
          <span data-slot="go-bar-line">
            <b className="font-medium text-fg">G</b> pressed · Select a nav item by its letter
            {sample !== undefined && (
              <>
                , like <b className="font-medium text-fg">{sample.key}</b> to open {sample.label}
              </>
            )}
          </span>
          <Kbd aria-label="Escape leaves go-mode">Esc</Kbd>
        </>
      )}
    </div>
  );
}

export { GoBar, type GoBarProps };
