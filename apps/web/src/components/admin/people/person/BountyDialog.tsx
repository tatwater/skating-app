import { effectiveBountyLimitOf } from '@skating/core';
import { useState } from 'react';

import { NumberField } from '@/components/kit/number-field';
import { RadioGroup, RadioRow } from '@/components/kit/radio';

import { AskDialog } from './AskDialog';
import { WORDS } from './personWords';
import type { ActOutcome } from './useActing';

/**
 * Set a person's bounty limit: the default, or a limit of their own (zero stops bounties outright and
 * leaves everything else as it is). A reason is asked only when the limit in force goes down —
 * raising it, or putting it back to the default from below, takes nothing away (the server's own
 * rule, which the page is told to apply from the value chosen).
 */

export type BountyDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  /** Their own limit now, or `null` for the default. */
  current: number | null;
  /** The default every account has. */
  defaultLimit: number;
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
  onConfirm,
}: BountyDialogProps) {
  const [mode, setMode] = useState<'default' | 'own'>(current === null ? 'default' : 'own');
  const [value, setValue] = useState<number | null>(current);
  const next = mode === 'default' ? null : value;
  const valid = mode === 'default' || (value !== null && Number.isInteger(value) && value >= 0);
  const unchanged = valid && next === current;
  return (
    <AskDialog
      open={open}
      onOpenChange={onOpenChange}
      title={WORDS.bountyTitle(name)}
      description={WORDS.bountyBody}
      confirm="Set limit"
      reason={valid && lowersLimit(current, next)}
      ready={valid && !unchanged}
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
    </AskDialog>
  );
}
