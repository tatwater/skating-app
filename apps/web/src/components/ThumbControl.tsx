import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { RatingTargetType } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * The helpful / unhelpful thumbs control (D50 decision 4) — one shared component driving the polymorphic
 * `ratings.rate` mutation over a report **or** a hazard. Helpful boosts the target author's trust; a
 * thumbs-down never publicly penalizes (boost-only) — it just accumulates toward the mod queue server-side.
 *
 * Counts are always shown (a public signal). Buttons are enabled only when `canRate` (signed in and not
 * your own content — the server also rejects self-rating and discards block-grudge thumbs-downs). When the
 * viewer is the bounty requester, `bountyId` is threaded so a **helpful** thumb on a fulfilling report
 * also fulfills the bounty (decisions 10–11).
 */
export function ThumbControl({
  targetType,
  targetId,
  canRate,
  bountyId,
}: {
  targetType: RatingTargetType;
  targetId: string;
  canRate: boolean;
  bountyId?: Id<'bounties'>;
}) {
  const summary = useQuery(api.ratings.summaryForTarget, { targetType, targetId });
  const rate = useMutation(api.ratings.rate);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cast = async (verdict: 'helpful' | 'unhelpful') => {
    setPending(true);
    setError(null);
    try {
      await rate({
        targetType,
        targetId,
        verdict,
        ...(bountyId ? { bountyId } : {}),
      });
    } catch (err) {
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : 'Could not record that — check your connection and try again.',
      );
    } finally {
      setPending(false);
    }
  };

  const helpful = summary?.helpful ?? 0;
  const unhelpful = summary?.unhelpful ?? 0;
  const mine = summary?.mine ?? null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <ThumbButton
          label="Helpful"
          emoji="👍"
          count={helpful}
          active={mine === 'helpful'}
          activeClass="border-primary bg-primary/10 text-primary"
          disabled={!canRate || pending || summary === undefined}
          onClick={() => cast('helpful')}
        />
        <ThumbButton
          label="Not helpful"
          emoji="👎"
          count={unhelpful}
          active={mine === 'unhelpful'}
          activeClass="border-border bg-muted text-foreground"
          disabled={!canRate || pending || summary === undefined}
          onClick={() => cast('unhelpful')}
        />
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ThumbButton({
  label,
  emoji,
  count,
  active,
  activeClass,
  disabled,
  onClick,
}: {
  label: string;
  emoji: string;
  count: number;
  active: boolean;
  activeClass: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label} (${count})`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors disabled:opacity-50',
        active ? activeClass : 'border-border text-foreground-muted hover:bg-surface-muted',
      )}
    >
      <span aria-hidden>{emoji}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  );
}
