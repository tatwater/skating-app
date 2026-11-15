import { useState } from 'react';

import { RadioGroup, RadioRow } from '@/components/kit/radio';

import { AskDialog } from './AskDialog';
import { momentWords } from './personModel';

/**
 * Suspend, or extend a suspension: how long, then why. A suspension lifts on its own when it runs
 * out; extending adds the time to the end already set. Each duration says when it would lift, so
 * the operator reads the end before choosing it.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The durations offered, in the order they read. */
export const SUSPEND_DURATIONS = [
  { id: '1d', label: '1 day', ms: DAY },
  { id: '3d', label: '3 days', ms: 3 * DAY },
  { id: '1w', label: '1 week', ms: 7 * DAY },
  { id: '2w', label: '2 weeks', ms: 14 * DAY },
  { id: '30d', label: '30 days', ms: 30 * DAY },
] as const;

export type SuspendDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Who is being suspended (their real name). */
  name: string;
  /** Extend the suspension already running, from its end (`until`). */
  extend: boolean;
  /** The running suspension's end, when extending; ignored otherwise. */
  until: number | null;
  /** The account is banned now: a suspension replaces the ban. */
  replacesBan?: boolean;
  /** The clock the ends are read from. */
  now: number;
  timeZone?: string;
  /** Runs the write; resolves to the server's refusal, or `null`. */
  onConfirm: (args: { until: number; reason: string }) => Promise<string | null>;
};

/** When a suspension of `ms` would lift: from now, or from the running end when extending. */
export function liftsAt(ms: number, now: number, extendFrom: number | null): number {
  return Math.max(now, extendFrom ?? now) + ms;
}

export function SuspendDialog({
  open,
  onOpenChange,
  name,
  extend,
  until,
  replacesBan = false,
  now,
  timeZone,
  onConfirm,
}: SuspendDialogProps) {
  const [choice, setChoice] = useState<string>(SUSPEND_DURATIONS[0].id);
  const from = extend ? until : null;
  const ms = SUSPEND_DURATIONS.find((d) => d.id === choice)?.ms ?? DAY;
  return (
    <AskDialog
      open={open}
      onOpenChange={onOpenChange}
      title={extend ? `Extend ${name}’s suspension?` : `Suspend ${name}?`}
      description={
        extend
          ? 'The time is added to the end already set. It still lifts on its own.'
          : replacesBan
            ? 'This replaces the ban. They can’t use their account until it lifts on its own.'
            : 'They can’t use their account until it lifts on its own. Everything they posted stays up.'
      }
      confirm={extend ? 'Extend' : 'Suspend'}
      reason
      onConfirm={(reason) => onConfirm({ until: liftsAt(ms, now, from), reason })}
    >
      <RadioGroup
        aria-label={extend ? 'Extend by' : 'For how long'}
        value={choice}
        onValueChange={(v) => setChoice(String(v))}
        data-slot="suspend-durations"
      >
        {SUSPEND_DURATIONS.map((d) => (
          <RadioRow
            key={d.id}
            value={d.id}
            label={extend ? `${d.label} more` : d.label}
            description={`Lifts ${momentWords(liftsAt(d.ms, now, from), now, timeZone)}`}
          />
        ))}
      </RadioGroup>
    </AskDialog>
  );
}
