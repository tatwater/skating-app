import { useState } from 'react';

import { RadioGroup, RadioRow } from '@/components/kit/radio';

import { AskDialog } from './AskDialog';
import { momentWords } from './personModel';
import { WORDS } from './personWords';
import type { ActOutcome } from './useActing';

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
  /** The reason's cap, passed to the dialog's field (the Inbox passes the server's); none by default. */
  maxLength?: number;
  /** Runs the write; resolves what it came to (the dialog closes once it landed). */
  onConfirm: (args: {
    until: number;
    reason: string;
    shape: ReturnType<typeof shapeOf>;
  }) => Promise<ActOutcome>;
};

/**
 * What the dialog is doing: a new suspension; more time on a running end (`extend`); an end for an
 * open-ended one (`setEnd`); or a new window from now for one that ran its course (`renew`). Each
 * duration's line says when it would lift, so the new end is read before it is chosen.
 */
export function shapeOf(
  extend: boolean,
  until: number | null,
  now: number,
): 'suspend' | 'extend' | 'setEnd' | 'renew' {
  if (!extend) return 'suspend';
  if (until === null) return 'setEnd';
  return until <= now ? 'renew' : 'extend';
}

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
  maxLength,
  onConfirm,
}: SuspendDialogProps) {
  const [choice, setChoice] = useState<string>(SUSPEND_DURATIONS[0].id);
  const shape = shapeOf(extend, until, now);
  // Time is added to a running end; an open-ended or run-out suspension's new end runs from now.
  const from = shape === 'extend' ? until : null;
  const ms = SUSPEND_DURATIONS.find((d) => d.id === choice)?.ms ?? DAY;
  const words = {
    suspend: {
      title: WORDS.suspendTitle(name),
      body: replacesBan ? WORDS.replacesBanBody : WORDS.suspendBody,
      confirm: 'Suspend',
    },
    extend: { title: WORDS.extendTitle(name), body: WORDS.extendBody, confirm: WORDS.extend },
    setEnd: { title: WORDS.setEndTitle(name), body: WORDS.setEndBody, confirm: WORDS.setAnEnd },
    renew: { title: WORDS.renewTitle(name), body: WORDS.renewBody, confirm: WORDS.extend },
  }[shape];
  return (
    <AskDialog
      open={open}
      onOpenChange={onOpenChange}
      title={words.title}
      description={words.body}
      confirm={words.confirm}
      reason
      {...(maxLength !== undefined && { maxLength })}
      onConfirm={(reason) => onConfirm({ until: liftsAt(ms, now, from), reason, shape })}
    >
      <RadioGroup
        aria-label={shape === 'extend' ? WORDS.extendBy : WORDS.forHowLong}
        value={choice}
        onValueChange={(v) => setChoice(String(v))}
        data-slot="suspend-durations"
      >
        {SUSPEND_DURATIONS.map((d) => (
          <RadioRow
            key={d.id}
            value={d.id}
            label={shape === 'extend' ? WORDS.durationMore(d.label) : d.label}
            description={WORDS.liftsAt(momentWords(liftsAt(d.ms, now, from), now, timeZone))}
          />
        ))}
      </RadioGroup>
    </AskDialog>
  );
}
