import type { ComponentProps } from 'react';

import { Badge } from '@/components/kit/badge';
import { cn } from '@/lib/utils';

import type { RunChip } from './runRows';

/**
 * **A run list's row** (board 6.2's middle column; every later pipeline's runs reuse it, the mocks'
 * `runsRows`) — a **kit candidate**, built kit-shaped here until the governor promotes it: the state
 * chip and the kind chip over the title, the sub-line under it, the age on the title's baseline.
 *
 * An option of its list's listbox, reached through `aria-activedescendant` (never its own focus):
 * the list owns the keys. Hover and the keyboard's cursor share one quiet lift; the open row carries
 * the selection wash and the white rule on its left edge.
 *
 * Chip tones by meaning: red won't recover without a person, amber is late or held, the live tone
 * breathes while a run reports, the quiet outline is a finished run, a dashed one a fact not
 * recorded. Success has no color of its own.
 */

export type RunRowProps = Omit<ComponentProps<'div'>, 'title'> & {
  title: string;
  state: RunChip;
  kind: RunChip;
  sub: string;
  age: string;
  /** The keyboard's cursor is on it (the list is focused). */
  active?: boolean;
  /** Open in the detail column. */
  selected?: boolean;
};

export function RunChipBadge({
  chip,
  className,
  ...props
}: { chip: RunChip } & ComponentProps<'span'>) {
  switch (chip.tone) {
    case 'bad':
    case 'warn':
    case 'dim':
      return (
        <Badge variant="outline" tone={chip.tone} className={className} {...props}>
          {chip.label}
        </Badge>
      );
    case 'lit':
      return (
        <Badge variant="live" tone="default" className={className} {...props}>
          {chip.label}
        </Badge>
      );
    case 'ok':
      // A finished run: the quiet outline one step brighter than the kind's (the board's `.pill.ok`).
      return (
        <Badge
          variant="outline"
          tone="default"
          className={cn('border-fg3 text-fg1', className)}
          {...props}
        >
          {chip.label}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" tone="default" className={className} {...props}>
          {chip.label}
        </Badge>
      );
  }
}

export function RunRow({
  title,
  state,
  kind,
  sub,
  age,
  active = false,
  selected = false,
  className,
  ...props
}: RunRowProps) {
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: an option is reached through the listbox's aria-activedescendant, never by its own focus
    <div
      role="option"
      aria-selected={selected}
      data-slot="run-row"
      data-active={active ? '' : undefined}
      data-selected={selected ? '' : undefined}
      className={cn(
        'grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-(--space-3) px-gutter py-(--space-2_5)',
        'border-0 border-b-(length:--stroke-hair) border-dotted border-line',
        'transition-[background-color] duration-(--duration-fast) ease-standard',
        '[@media(hover:hover)]:not-data-selected:hover:bg-lift-05',
        'not-data-selected:data-active:bg-lift-05',
        'data-selected:bg-lift-08 data-selected:shadow-select-rule',
        className,
      )}
      {...props}
    >
      <span className="col-start-1 row-start-1 min-w-0">
        <span
          data-slot="run-row-chips"
          className="mb-(--space-1_5) flex flex-wrap items-center gap-(--space-1_5)"
        >
          <RunChipBadge chip={state} data-slot="run-row-state" data-tone={state.tone} />
          <RunChipBadge chip={kind} data-slot="run-row-kind" />
        </span>
        <span
          data-slot="run-row-title"
          className="block min-w-0 truncate text-body leading-(--lead-snug) font-medium text-fg1 in-data-selected:text-fg"
        >
          {title}
        </span>
        <span
          data-slot="run-row-sub"
          className="mt-(--space-0_5) block min-w-0 text-assist leading-list text-fg3 in-data-selected:text-fg2"
        >
          {sub}
        </span>
      </span>
      <span
        data-slot="run-row-age"
        className="col-start-2 row-start-1 pt-(--space-0_5) font-(family-name:--family-mono) text-mono-sm leading-none whitespace-nowrap text-fg3"
      >
        {age}
      </span>
    </div>
  );
}
