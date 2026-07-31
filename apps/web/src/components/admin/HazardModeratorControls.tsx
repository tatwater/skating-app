import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { BODY_FEATURE_TYPE_LABELS, BODY_FEATURE_TYPES } from '@skating/core';
import { useMutation } from 'convex/react';
import { useState } from 'react';
import { useRole } from '../../lib/useRole';
import { ModeratorActions } from '../ModeratorActions';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ReasonDialog } from './ReasonDialog';

/**
 * In-context moderator affordances for a hazard pin (D37/D53) — take the pin down (hide/remove, the
 * same server-gated mutation the flag queue uses) and **promote a recurring hazard into a persistent
 * body feature** right from where it is, so a permanent risk stops needing user re-marking. Renders
 * nothing for non-moderators.
 *
 * The feature-type list comes from `@skating/core` (N5c) rather than being a hand-kept copy — D79's
 * authoring form on the lake page made it the third reader, and a third copy is how a new type
 * reaches the schema while one surface goes on offering eight.
 */
const FEATURE_TYPES = BODY_FEATURE_TYPES.map((value) => ({
  value,
  label: BODY_FEATURE_TYPE_LABELS[value],
}));

export function HazardModeratorControls({ hazardId }: { hazardId: string }) {
  const { canModerate } = useRole();
  const promote = useMutation(api.bodyFeatures.promote);
  const [type, setType] = useState<(typeof FEATURE_TYPES)[number]['value']>('spring_current');

  if (!canModerate) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ModeratorActions targetType="hazard" targetId={hazardId} />
      <ReasonDialog
        trigger={
          <Button variant="ghost" size="sm">
            Promote to known feature
          </Button>
        }
        title="Promote to a known body feature"
        description="Graduates this recurring hazard into a persistent feature — no decay, no re-marking."
        confirmLabel="Promote"
        confirmVariant="default"
        extraFields={
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="feature-type">Feature type</Label>
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger id="feature-type" size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEATURE_TYPES.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
        onConfirm={(reason) => promote({ hazardId: hazardId as Id<'hazards'>, type, reason })}
      />
    </div>
  );
}
