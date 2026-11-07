import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import type { ReactNode } from 'react';
import { Collapsible, CollapsibleChevron, CollapsibleContent } from '@/components/kit/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { cn } from '@/lib/utils';

/**
 * One question of the report sheet (B03 §5, boards 5.1–5.12): the folded line is the 44 px row —
 * the square (hollow, filled once answered, amber while a refused *Post* needs it), the title in
 * caps, the answer's summary at the right in mono, the chevron — and the whole row opens it.
 *
 * **No helper lines under a head** (Review 3): what a control needs explaining says so in a tooltip
 * on that control (`SubLabel`'s `tip`). What a panel still prints (`SheetHint`) is state — a refusal,
 * an empty list — never instructions.
 *
 * The open/closed state is the sheet's own (`collapsed`, core's reducer), so a reload and a second
 * tab keep it; the kit `Collapsible` draws the reveal.
 */
export function SheetPanel({
  label,
  summary,
  collapsed,
  onToggle,
  gap = false,
  children,
  id,
}: {
  label: string;
  summary: string;
  collapsed: boolean;
  onToggle: () => void;
  /** A refused *Post* needs this section (D189). */
  gap?: boolean;
  children: ReactNode;
  id?: string;
}) {
  const filled = summary.length > 0;
  return (
    <Collapsible
      {...(id !== undefined ? { id } : {})}
      open={!collapsed}
      onOpenChange={(open) => {
        if (open === collapsed) onToggle();
      }}
      data-slot="sheet-section"
      data-gap={gap ? '' : undefined}
      className="border-0 border-b border-solid border-line"
    >
      <CollapsiblePrimitive.Trigger
        data-slot="sheet-section-trigger"
        data-attr={id}
        className={cn(
          'group/collapsible flex h-11 w-full cursor-pointer items-center gap-(--space-2_5) border-0 bg-transparent px-0 text-left outline-none',
          'focus-visible:shadow-focus',
        )}
      >
        <StatusSquare state={gap ? 'needed' : filled ? 'filled' : 'empty'} />
        <span className="text-kick leading-none font-semibold tracking-head text-fg uppercase">
          {label}
        </span>
        <span
          data-slot="sheet-section-value"
          className={cn(
            'ml-auto min-w-0 truncate font-(family-name:--family-mono) text-mono-sm leading-none',
            gap ? 'text-warn' : 'text-fg2',
          )}
        >
          {gap ? 'Needed' : collapsed ? summary : ''}
        </span>
        <CollapsibleChevron className="text-fg3 group-data-panel-open/collapsible:rotate-90" />
      </CollapsiblePrimitive.Trigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-(--space-2_5) pt-0.5 pb-(--space-4_5)">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A small caps label — a kicker over a value. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-kick leading-none font-medium tracking-head text-fg3 uppercase',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The section's square: hollow, answered, needed — or ice (saved, live). */
export function StatusSquare({ state }: { state: 'empty' | 'filled' | 'needed' | 'ice' }) {
  return (
    <span
      aria-hidden
      data-state={state}
      className={cn(
        'inline-block size-2 shrink-0',
        state === 'empty' && 'inset-ring inset-ring-fg2',
        state === 'filled' && 'bg-fg1',
        state === 'needed' && 'bg-warn shadow-[0_0_6px_var(--warn)]',
        state === 'ice' && 'bg-acc',
      )}
    />
  );
}

/** A state line inside a panel — a refusal, an empty list. Never instructions (those are tooltips). */
export function SheetHint({ children }: { children: ReactNode }) {
  return <p className="m-0 text-assist leading-body text-fg3 [text-wrap:pretty]">{children}</p>;
}

/**
 * A sub-question's label ("Did it hold you?"). `tip` is what it would have explained in a helper
 * line, as the one tooltip style, on the label itself.
 */
export function SubLabel({ children, tip }: { children: ReactNode; tip?: string }) {
  const label = (
    <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
      {children}
    </span>
  );
  return (
    <p className="m-0 mt-(--space-1_5)">
      {tip === undefined ? (
        label
      ) : (
        <Tooltip>
          <TooltipTrigger variant="text" tabIndex={0}>
            {label}
          </TooltipTrigger>
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      )}
    </p>
  );
}

/** A question asked in place (where, put-in): the open card with its Done. Ice: the map is the input. */
export function QuestionBlock({
  title,
  onDone,
  extra,
  children,
}: {
  title: string;
  onDone: () => void;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-(--space-2_5) border border-solid border-acc bg-acc-wash p-(--space-3_5)">
      <div className="flex items-center gap-(--space-2_5)">
        <span className="text-kick leading-none font-semibold tracking-head text-fg uppercase">
          {title}
        </span>
        <span className="flex-1" />
        {extra}
        <button
          type="button"
          onClick={onDone}
          data-attr="sheet-question-done"
          className="h-btn-xs rounded-control border-0 bg-inv-bg px-(--space-2_5) text-kick font-semibold tracking-head text-inv-fg uppercase outline-none focus-visible:shadow-focus"
        >
          Done
        </button>
      </div>
      {children}
    </div>
  );
}
