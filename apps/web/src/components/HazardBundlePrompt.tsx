import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type HazardType, hazardTypeLabel } from '@skating/core';
import { useQuery } from 'convex/react';
import { useEffect } from 'react';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';

/**
 * The D55 auto-bundle prompt: offer the author's own on-ice hazards into the report they're writing.
 *
 * A hazard flagged from the ice is a standalone row; when the same skater writes their report for
 * that lake and skate window, re-entering it would be busywork. So we offer to attach them —
 * **pre-checked and itemized, never silently**. Attaching changes how the observation is attributed
 * and how it presents in the feed, so it stays a visible choice.
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
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 font-medium text-sm">
        You flagged {candidates.length} hazard{candidates.length === 1 ? '' : 's'} here
      </legend>
      <p className="text-foreground-muted text-xs">
        Include them in this report? They stay on the map either way.
      </p>
      {candidates.map((candidate) => (
        <div key={candidate._id} className="flex items-center gap-2">
          <Checkbox
            id={`bundle-${candidate._id}`}
            checked={selectedIds.includes(candidate._id)}
            onCheckedChange={(checked) => onToggle(candidate._id, checked === true)}
          />
          <Label htmlFor={`bundle-${candidate._id}`} className="font-normal text-sm">
            {hazardTypeLabel(candidate.type)}
          </Label>
        </div>
      ))}
    </fieldset>
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

  const candidateKey = (candidates ?? []).map((c) => c._id).join(',');
  // `candidateKey` is the stable content signature of the candidate set, so this only re-runs when
  // the actual hazards change — not on every query object identity.
  useEffect(() => {
    onCandidates(candidateKey ? candidateKey.split(',') : []);
  }, [candidateKey, onCandidates]);

  return (
    <HazardBundlePromptView
      candidates={candidates ?? []}
      selectedIds={selectedIds}
      onToggle={onToggle}
    />
  );
}
