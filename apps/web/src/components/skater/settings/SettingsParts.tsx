import { type ReactNode, useId } from 'react';

import { cn } from '@/lib/utils';

import { Switch } from '../../kit/switch';

/**
 * The pieces every settings section is drawn from (row 7), props only. Tokens for every color and
 * type step; the classes here are layout.
 */

/** The section's head: the display title, then what the section is for. */
export function PaneHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--space-2)">
      <h1 className="m-0 font-semibold text-disp-lg text-fg uppercase leading-[1.05] tracking-disp">
        {title}
      </h1>
      {children != null && (
        <p className="m-0 max-w-[37.5rem] text-pretty text-fg2 text-row leading-body">{children}</p>
      )}
    </div>
  );
}

/** A group of rows or fields inside a section. */
export function Block({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex min-w-0 flex-col gap-(--space-3_5)', className)}>{children}</div>;
}

/** A paragraph inside a block: the body ink, or `muted` for the smaller second voice. */
export function BlockText({ muted = false, children }: { muted?: boolean; children: ReactNode }) {
  return (
    <p
      className={cn(
        'm-0 text-pretty leading-body',
        muted ? 'text-assist text-fg2' : 'text-fg1 text-row',
      )}
    >
      {children}
    </p>
  );
}

/**
 * Ruled rows, label left (150 px), value, then the row's own action. The list ends on its spacing:
 * the last row has no rule (Review 3).
 */
export function Rows({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <dl
      aria-label={label}
      className="m-0 flex flex-col border-0 border-line border-t border-solid [&>div:last-child]:border-b-0"
    >
      {children}
    </dl>
  );
}

export function Row({
  label,
  sub,
  action,
  mono = false,
  muted = false,
  children,
}: {
  label: string;
  /** The small line under the value. */
  sub?: ReactNode;
  action?: ReactNode;
  mono?: boolean;
  /** A value that is the absence of one ("Not set"). */
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="settings-row"
      className="flex min-h-[3.25rem] items-center gap-(--space-4) border-0 border-line border-b border-solid py-(--space-2_5)"
    >
      <dt className="w-[9.375rem] flex-none text-assist text-fg2 leading-snug">{label}</dt>
      <dd className="m-0 min-w-0 flex-1">
        <span
          className={cn(
            'block text-body leading-snug',
            muted ? 'text-fg2' : 'text-fg',
            mono && 'font-(family-name:--family-mono) text-row',
          )}
        >
          {children}
        </span>
        {sub != null && (
          <span className="mt-[0.1875rem] block text-assist text-fg3 leading-snug">{sub}</span>
        )}
      </dd>
      {action != null && (
        <div className="flex flex-none items-center gap-(--space-2)">{action}</div>
      )}
    </div>
  );
}

/** A stack of switch rows, ruled above; the last row keeps no rule under it. */
export function ToggleGroupRows({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col border-0 border-line border-t border-solid [&>*:last-child]:border-b-0">
      {children}
    </div>
  );
}

/**
 * One setting that flips: its words left, the switch right (the map-layers switch). The whole
 * label names the switch; the explainer describes it. Saves on flip — no second step.
 */
export function ToggleRow({
  label,
  explainer,
  checked,
  onCheckedChange,
  disabled = false,
  badge,
  extra,
  dataAttr,
}: {
  label: ReactNode;
  explainer?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** A mark after the label (the envelope that says "also by email"). */
  badge?: ReactNode;
  /** What sits under the words (a "Within" picker). */
  extra?: ReactNode;
  dataAttr?: string;
}) {
  const id = useId();
  return (
    <div
      data-slot="toggle-row"
      className="flex items-start gap-(--space-4) border-0 border-line border-b border-solid py-(--space-3_5)"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-(--space-1)">
        <span className="flex items-center gap-(--space-2) text-body text-fg leading-snug">
          <label htmlFor={id}>{label}</label>
          {badge}
        </span>
        {explainer != null && (
          <span id={`${id}-x`} className="text-assist text-fg3 leading-[1.45]">
            {explainer}
          </span>
        )}
        {extra}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
        aria-describedby={explainer != null ? `${id}-x` : undefined}
        data-attr={dataAttr}
        className="mt-[0.125rem]"
      />
    </div>
  );
}

/** A thin "or" between two ways of doing one thing. */
export function OrRule() {
  return (
    <div className="flex items-center gap-(--space-3) text-assist text-fg3 before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      or
    </div>
  );
}

/** A row of actions under a block. */
export function Actions({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-(--space-2)', className)}>{children}</div>
  );
}
