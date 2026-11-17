import { effectiveBountyLimitOf } from '@skating/core';
import { useState } from 'react';

import { NumberField } from '@/components/kit/number-field';
import { RadioGroup, RadioRow } from '@/components/kit/radio';

import { AskDialog } from './AskDialog';
import type { Can } from './personModel';
import { WORDS } from './personWords';
import type { ActOutcome } from './useActing';

/**
 * Set a person's bounty limit: the default, or a limit of their own (zero stops bounties outright and
 * leaves everything else as it is). Which way a choice moves the limit in force decides which of the
 * server's two answers holds (`can.bountyLower` when it goes down, `can.bountyRaise` otherwise —
 * raising it, or putting it back to the default from below): a choice that way can be sent only when
 * that answer is open, and asks a reason exactly when it says so (lowering takes something away).
 */

export type BountyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  /** Their own limit now, or `null` for the default. */
  current: number | null;
  /** The default every account has. */
  defaultLimit: number;
  /**
   * The server's answer for each way the limit can move (`can.bountyRaise`, `can.bountyLower`): a
   * choice the server would refuse can't be sent, and the reason is asked exactly when its answer
   * says so.
   */
  raise: Can;
  lower: Can;
  onConfirm: (args: { limit: number | null; reason: string }) => Promise<ActOutcome>;
};

/** Whether moving from `current` to `next` lowers the limit in force — and so asks why. */
export function lowersLimit(current: number | null, next: number | null): boolean {
  return effectiveBountyLimitOf(next) < effectiveBountyLimitOf(current);
}

export function BountyDialog({
  open,
  onOpenChange,
  name,
  current,
  defaultLimit,
  raise,
  lower,
  onConfirm,
}: BountyDialogProps) {
  const [mode, setMode] = useState<'default' | 'own'>(current === null ? 'default' : 'own');
  const [value, setValue] = useState<number | null>(current);
  const next = mode === 'default' ? null : value;
  const valid = mode === 'default' || (value !== null && Number.isInteger(value) && value >= 0);
  const unchanged = valid && next === current;
  // The way this choice moves the limit in force, and the server's answer for it.
  const way = valid && !unchanged ? (lowersLimit(current, next) ? lower : raise) : null;
  return (
    <AskDialog
      open={open}
      onOpenChange={onOpenChange}
      title={WORDS.bountyTitle(name)}
      description={WORDS.bountyBody}
      confirm="Set limit"
      reason={way?.ok === true && way.needsReason}
      ready={way?.ok === true}
      onConfirm={(reason) => onConfirm({ limit: next, reason })}
    >
      <RadioGroup
        aria-label="Bounty limit"
        value={mode}
        onValueChange={(v) => setMode(v === 'own' ? 'own' : 'default')}
        data-slot="bounty-mode"
      >
        <RadioRow value="default" label={WORDS.bountyDefault(defaultLimit)} />
        <RadioRow value="own" label={WORDS.bountyOwn} />
      </RadioGroup>
      {mode === 'own' && (
        <NumberField
          label={WORDS.bountyField}
          unit={WORDS.perDay}
          min={0}
          step={1}
          value={value}
          onValueChange={(v) => setValue(v)}
          data-slot="bounty-limit"
        />
      )}
      {/* The read's answer for a way the server won't move it — never a write's refusal. */}
      {way !== null && !way.ok && (
        <p data-slot="bounty-refused" className="m-0 text-assist leading-list text-fg2">
          {way.why}
        </p>
      )}
    </AskDialog>
  );
}
