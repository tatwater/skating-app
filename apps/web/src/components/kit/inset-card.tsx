import { type ComponentProps, type ReactNode, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Kbd } from './kbd';
import { plateVariants } from './plate';

/**
 * A task on one thing — edit a landmark, drop one,
 * link a lot — on a temporary card over the inspector (Review 14's `.icard`): what the pane showed
 * stays put behind it, dimmed, and the map stays live beside it.
 *
 * - **A container, so square**, a step lighter than the pane (`panel`), edged in the rule gray with
 *   the card's corner ticks, lifted by a dark ring and a soft drop (`shadow-modal`).
 * - **The head is one control, the whole zone**: ‹ Back to …, its Esc cap at the far end, over its
 *   own rule. Esc anywhere in the card goes back too.
 * - **The foot is the sheet foot**: a ruled strip at the card's bottom edge, actions left, a
 *   destructive one pushed right (`InsetCardFoot`'s `end`). Edits that save in place need no Save.
 * - **Focus moves in** to the head when the card opens, so the keyboard is where the task is.
 *
 * The caller places it (`absolute`, over its pane); the card fills what it's given.
 */

type InsetCardProps = Omit<ComponentProps<'section'>, 'title'> & {
  /** The head's words: "Back to landmarks". */
  back: string;
  onBack: () => void;
  /** The card's foot (`InsetCardFoot`), if it has one. */
  foot?: ReactNode;
};

function InsetCard({
  back,
  onBack,
  foot,
  className,
  children,
  onKeyDown,
  ...props
}: InsetCardProps) {
  const head = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    head.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      data-slot="inset-card"
      aria-label={back}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onBack();
        }
      }}
      className={cn(
        plateVariants({ variant: 'card' }),
        'z-(--z-icard) gap-0 border-line2 bg-panel p-0 shadow-modal',
        className,
      )}
      {...props}
    >
      <button
        ref={head}
        type="button"
        data-slot="inset-card-head"
        onClick={onBack}
        className={cn(
          'flex h-(--size-top) shrink-0 cursor-pointer items-center gap-(--space-2_5) pr-(--space-3) pl-(--space-4)',
          'border-0 border-b border-solid border-line2 bg-raise text-left outline-none',
          'text-kick leading-none font-semibold tracking-head text-fg1 uppercase',
          'transition-[background-color,color] duration-(--duration-fast) ease-standard',
          'lit:bg-lift-08 lit:text-fg focus-visible:shadow-focus',
        )}
      >
        <span aria-hidden="true">‹</span>
        <span className="min-w-0 flex-1 truncate">{back}</span>
        <Kbd variant="dim" aria-hidden="true">
          Esc
        </Kbd>
      </button>
      <div
        data-slot="inset-card-body"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-(--space-4) pt-(--space-5)"
      >
        {children}
      </div>
      {foot}
    </section>
  );
}

type InsetCardFootProps = ComponentProps<'div'> & {
  /** Pushed to the far end — a destructive action. */
  end?: ReactNode;
};

/** The card's foot: the sheet foot's ruled strip, actions left, `end` right. */
function InsetCardFoot({ end, className, children, ...props }: InsetCardFootProps) {
  return (
    <div
      data-slot="inset-card-foot"
      className={cn(
        'flex h-(--space-14) shrink-0 items-center gap-(--space-2_5) px-(--space-4)',
        'border-0 border-t border-solid border-line2',
        className,
      )}
      {...props}
    >
      {children}
      {end != null && <span className="ms-auto flex items-center">{end}</span>}
    </div>
  );
}

export { InsetCard, InsetCardFoot, type InsetCardFootProps, type InsetCardProps };
