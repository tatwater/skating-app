import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faThumbsDown, faThumbsUp } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { RatingTargetType } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '../../kit/button';

/**
 * The thumbs (D50; boards 2.1, 2.4, 2.6/2.7): **Helpful** with its public count, and **Not helpful**,
 * which never shows a number — a thumbs-down only ever feeds the moderation queue, so a public count
 * would be a pillory. These are a person's opinion of a report, never a reading of the ice.
 *
 * Props only. `canRate` is false for the author, the signed-out and a leaving account; the counts
 * still show. `compact` drops the words (a bounty's candidate rows).
 */
export interface RatingsRowViewProps {
  helpful: number;
  mine: 'helpful' | 'unhelpful' | null;
  canRate: boolean;
  pending?: boolean;
  error?: string | null;
  /** The counts are still loading: the buttons hold their place, inert. */
  loading?: boolean;
  compact?: boolean;
  /** Show Not helpful (a candidate row shows it only to the bounty's requester). */
  withUnhelpful?: boolean;
  onRate: (verdict: 'helpful' | 'unhelpful') => void;
}

export function RatingsRowView({
  helpful,
  mine,
  canRate,
  pending = false,
  error = null,
  loading = false,
  compact = false,
  withUnhelpful = true,
  onRate,
}: RatingsRowViewProps) {
  const inert = !canRate || pending || loading;
  return (
    <div data-slot="ratings-row" className="flex items-center gap-(--space-2)">
      <Button
        size="sm"
        data-attr="rate-helpful"
        aria-pressed={mine === 'helpful'}
        aria-label={`Helpful, ${helpful}`}
        disabled={inert}
        className={cn(mine === 'helpful' && 'text-fg inset-ring-fg')}
        onClick={() => onRate('helpful')}
      >
        <FontAwesomeIcon icon={faThumbsUp} aria-hidden="true" className="h-[0.8125rem]" />
        {compact ? null : 'Helpful'}
        <span className="ml-(--space-0_5) font-(family-name:--family-mono) font-medium tracking-normal">
          {helpful}
        </span>
      </Button>
      {withUnhelpful && (
        <Button
          size="sm"
          data-attr="rate-unhelpful"
          aria-pressed={mine === 'unhelpful'}
          aria-label="Not helpful"
          disabled={inert}
          className={cn(mine === 'unhelpful' && 'text-fg inset-ring-fg')}
          onClick={() => onRate('unhelpful')}
        >
          <FontAwesomeIcon icon={faThumbsDown} aria-hidden="true" className="h-[0.8125rem]" />
          {compact ? null : 'Not helpful'}
        </Button>
      )}
      {error !== null && (
        <span role="alert" className="text-assist text-bad">
          {error}
        </span>
      )}
    </div>
  );
}

/** Why a write didn't land, in the server's words when it gave some. */
export function writeError(err: unknown, fallback: string): string {
  return err instanceof ConvexError ? String(err.data) : fallback;
}

/**
 * The live thumbs: `ratings.summaryForTarget` for the counts, `ratings.rate` to cast. With a
 * `bountyId`, a helpful thumb from the bounty's requester also fulfills it (D47 decisions 10–11).
 */
export function RatingsRow({
  targetType,
  targetId,
  canRate,
  bountyId,
  compact,
  withUnhelpful,
}: {
  targetType: RatingTargetType;
  targetId: string;
  canRate: boolean;
  bountyId?: string;
  compact?: boolean;
  withUnhelpful?: boolean;
}) {
  const summary = useQuery(api.ratings.summaryForTarget, { targetType, targetId });
  const rate = useMutation(api.ratings.rate);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRate = async (verdict: 'helpful' | 'unhelpful') => {
    setPending(true);
    setError(null);
    try {
      await rate({
        targetType,
        targetId,
        verdict,
        ...(bountyId !== undefined ? { bountyId: bountyId as Id<'bounties'> } : {}),
      });
    } catch (err) {
      setError(writeError(err, 'Not saved. Check your connection and try again.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <RatingsRowView
      helpful={summary?.helpful ?? 0}
      mine={summary?.mine ?? null}
      canRate={canRate}
      pending={pending}
      error={error}
      loading={summary === undefined}
      {...(compact !== undefined ? { compact } : {})}
      {...(withUnhelpful !== undefined ? { withUnhelpful } : {})}
      onRate={(verdict) => void onRate(verdict)}
    />
  );
}
