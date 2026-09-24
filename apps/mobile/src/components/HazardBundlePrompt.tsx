import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type HazardType, hazardTypeLabel, queuedBundleCandidates } from '@skating/core';
import { useQuery } from 'convex/react';
import { useEffect, useMemo } from 'react';
import { Button, Paragraph, Text, XStack, YStack } from 'tamagui';
import { listHazardItems } from '../lib/draftStore';

/**
 * The D55 auto-bundle prompt (mobile) — offer the author's own on-ice hazards into the report
 * they're writing.
 *
 * This is the payoff for the two-tap on-ice flag: a hazard marked from the ice is a standalone row,
 * and making the skater re-enter it when they write the report that evening would be busywork of
 * exactly the kind that stops safety content getting filed.
 *
 * **Pre-checked, itemised, never silent.** Attaching changes how the observation is attributed and
 * how it presents in the feed, so it stays a visible choice — and the copy makes clear the hazards
 * stay on the map either way, so declining never feels like discarding them.
 */
export interface BundleCandidate {
  _id: string;
  type: HazardType;
  firstReportedAt: number;
}

export function HazardBundlePromptView({
  candidates,
  selectedIds,
  onToggle,
}: {
  candidates: readonly BundleCandidate[];
  selectedIds: readonly string[];
  onToggle: (hazardId: string, checked: boolean) => void;
}) {
  if (candidates.length === 0) return null;

  return (
    <YStack gap="$2" borderWidth={1} borderColor="$border" borderRadius="$4" padding="$3">
      <Text color="$foreground" fontWeight="700">
        You flagged {candidates.length} hazard{candidates.length === 1 ? '' : 's'} here
      </Text>
      <Paragraph color="$foregroundMuted" fontSize={12}>
        Include them in this report? They stay on the map either way.
      </Paragraph>
      {candidates.map((candidate) => {
        const selected = selectedIds.includes(candidate._id);
        return (
          <XStack key={candidate._id} gap="$2" alignItems="center">
            <Button
              size="$3"
              flex={1}
              justifyContent="flex-start"
              backgroundColor={selected ? '$primary' : undefined}
              color={selected ? '$primaryForeground' : undefined}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected }}
              onPress={() => onToggle(candidate._id, !selected)}
            >
              {selected ? '✓ ' : ''}
              {hazardTypeLabel(candidate.type)}
            </Button>
          </XStack>
        );
      })}
    </YStack>
  );
}

/** Container: looks up the author's unattached hazards for this body + skate window. */
export function HazardBundlePrompt({
  waterBodyId,
  skateEndTime,
  skateStartTime,
  selectedIds,
  onToggle,
  onCandidates,
}: {
  waterBodyId: string;
  skateEndTime: number;
  skateStartTime?: number;
  selectedIds: readonly string[];
  onToggle: (hazardId: string, checked: boolean) => void;
  /** Reports the candidate set upward so the form can pre-check them (D55: pre-checked, opt-out). */
  onCandidates: (hazardIds: string[]) => void;
}) {
  const candidates = useQuery(
    api.hazards.listBundleCandidates,
    Number.isFinite(skateEndTime) && skateEndTime > 0
      ? {
          waterBodyId: waterBodyId as Id<'waterBodies'>,
          skateEndTime,
          ...(skateStartTime !== undefined ? { skateStartTime } : {}),
        }
      : 'skip',
  );

  // The hazards captured on the ice and still on the phone (A10 §9.1): offered beside the server's,
  // by local id, so a report written before the queue drains can still bundle them. One that has
  // already flushed carries its server id and is offered under that — and deduped against the
  // server's list, which would have it too. Same lake, same window as the server's rule
  // (`queuedBundleCandidates`), so neither side pre-checks last week's hazard into today's report.
  const queued = useMemo(
    () =>
      queuedBundleCandidates(listHazardItems(), {
        waterBodyId,
        skateEndTime,
        ...(skateStartTime !== undefined ? { skateStartTime } : {}),
        serverIds: new Set<string>((candidates ?? []).map((c) => c._id)),
      }).map(
        (c): BundleCandidate => ({ _id: c.id, type: c.type, firstReportedAt: c.firstReportedAt }),
      ),
    [candidates, waterBodyId, skateEndTime, skateStartTime],
  );
  const all = useMemo(() => [...(candidates ?? []), ...queued], [candidates, queued]);

  const candidateKey = all.map((c) => c._id).join(',');
  // `candidateKey` is the stable content signature of the candidate set, so this only re-runs when
  // the actual hazards change — not on every query object identity.
  useEffect(() => {
    onCandidates(candidateKey ? candidateKey.split(',') : []);
  }, [candidateKey, onCandidates]);

  return <HazardBundlePromptView candidates={all} selectedIds={selectedIds} onToggle={onToggle} />;
}
