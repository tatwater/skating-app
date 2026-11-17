import { api } from '@skating/convex/api';
import type { Doc, Id } from '@skating/convex/dataModel';
import {
  AUDIT_REASON_MAX,
  describeStanding,
  MAX_STANDING_NOTE_LENGTH,
  standingOf,
  standingReasonLabel,
} from '@skating/core';
import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { type SetBanner, ToolCard } from './adminUi';
import { ReasonDialog } from './ReasonDialog';
import { useSaidMutation } from './said';

/** Why an admin delisted a body (D48). Mirrors `REMOVAL_REASONS`; the server validates the value. */
const REMOVAL_REASON_LABELS: Record<string, string> = {
  landowner_request: 'Landowner request',
  unskateable: 'Not skateable',
  junk: 'Junk data',
  duplicate: 'Duplicate',
  other: 'Other',
};

/**
 * Standing (A07b) — active, dormant, or off the map — with D48's remove/restore folded in.
 *
 * `remove`/`restore` shipped in Phase 02a and had no caller in either app until A06c, which meant a
 * landowner takedown — the case D48 was built *for* — could only be performed from the Convex
 * dashboard. A07b widened the card from "on the map or not" to the full standing: a moderator can
 * set a lake dormant with a note (the third rung the plan asked about — keep it, stop pushing it,
 * without the legal claim `none` makes), bring a shelved one back, or take it off the map
 * outright. The sentence at the top is `describeStanding` — the same one the skater reads in the
 * drawer — so an operator sees exactly what the public is told.
 *
 * Since A07b a removed body still draws when zoomed right in (dimmed, with the reason), so the old
 * "it draws nowhere" line is gone; what removal takes away is standing, search and every push
 * surface, and its bays' cells.
 *
 * Last in the tool column, above the history: it is the one card here that shelves or removes
 * rather than refines, and nothing that refines should sit below it.
 */
export function RemovalTool({ body, onResult }: { body: Doc<'waterBodies'>; onResult: SetBanner }) {
  const remove = useSaidMutation(api.waterBodies.remove);
  const restore = useSaidMutation(api.waterBodies.restore);
  const setStanding = useSaidMutation(api.standing.setStanding);
  const [reason, setReason] = useState('landowner_request');
  const [note, setNote] = useState('');
  const standing = standingOf(body);
  const line = describeStanding(standing);
  const label =
    standing.standing === 'active'
      ? 'Active'
      : standing.standing === 'unlisted'
        ? 'Not on the map'
        : `${standing.standing === 'removed' ? 'Removed' : 'Dormant'} — ${standingReasonLabel(standing.reason)}`;

  return (
    <ToolCard title="Standing">
      <p className="text-foreground text-sm">{label}</p>
      {line ? <p className="text-foreground-muted text-sm">{line}</p> : null}
      {body.activatedAt !== undefined ? (
        <p className="text-foreground-muted text-xs">
          Activated {new Date(body.activatedAt).toLocaleDateString()}.
        </p>
      ) : null}

      {standing.standing === 'removed' ? (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={async () => {
            try {
              await restore({ waterBodyId: body._id as Id<'waterBodies'> });
              onResult({ tone: 'ok', text: 'Restored — active again, and re-scored.' });
            } catch {
              // Refused: said in its toast (the net, D268).
            }
          }}
        >
          Restore to the map
        </Button>
      ) : null}

      {standing.standing === 'dormant' && standing.reason === 'no_public_access' ? (
        <p className="text-foreground-muted text-xs">
          Dormant because of the access ruling — change or clear the ruling in the Access section to
          bring it back.
        </p>
      ) : null}

      {standing.standing === 'dormant' && standing.reason !== 'no_public_access' ? (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={async () => {
            try {
              await setStanding({ waterBodyId: body._id as Id<'waterBodies'>, standing: 'active' });
              onResult({ tone: 'ok', text: 'Back on the active map.' });
            } catch {
              // Refused: said in its toast (the net, D268).
            }
          }}
        >
          Bring back to the active map
        </Button>
      ) : null}

      {standing.standing === 'active' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="standing-note">Note for skaters (shown on the lake)</Label>
          <Input
            id="standing-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Drained for dam work through 2027"
            maxLength={MAX_STANDING_NOTE_LENGTH}
          />
          <ReasonDialog
            trigger={
              <Button size="sm" variant="outline" className="self-start">
                Set dormant
              </Button>
            }
            title="Set this water body dormant"
            description="It stays on the map when zoomed right in, dimmed, with your note. It leaves search results’ top, notifications, weather discovery and the recommended strip. A report or a track will NOT bring it back — only a moderator will."
            confirmLabel="Set dormant"
            confirmVariant="secondary"
            requireReason={false}
            reasonPlaceholder="Optional note for the audit log"
            onConfirm={async (auditReason) => {
              // Refused: the net says it in a toast and rejects, so the dialog stays open.
              await setStanding({
                waterBodyId: body._id as Id<'waterBodies'>,
                standing: 'dormant',
                ...(note.trim() ? { note: note.trim() } : {}),
                ...(auditReason?.trim() ? { reason: auditReason.trim() } : {}),
              });
              setNote('');
              onResult({ tone: 'ok', text: 'Set dormant.' });
            }}
          />
        </div>
      ) : null}

      {standing.standing !== 'removed' && standing.standing !== 'unlisted' ? (
        <>
          <select
            className="rounded border border-border bg-surface px-2 py-1 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Removal reason"
          >
            {Object.entries(REMOVAL_REASON_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <ReasonDialog
            trigger={
              <Button size="sm" variant="outline" className="self-start">
                Take off the map
              </Button>
            }
            title="Remove this water body"
            description="It leaves search and every push surface, its named bays go with it, and it draws only when zoomed right in — dimmed, with the reason. Reversible from this card — nothing is deleted."
            confirmLabel="Remove"
            confirmVariant="secondary"
            requireReason={false}
            reasonPlaceholder="Optional note for the audit log"
            reasonMaxLength={AUDIT_REASON_MAX}
            onConfirm={async (removalNote) => {
              // Refused: the net says it in a toast and rejects, so the dialog stays open. The note is
              // the operator's own words: the server holds it to the audit cap and writes it beside
              // the fixed reason, where History and the removed lane read it. (Not the skaters'
              // dormant `note` above, which a removal never sends.)
              await remove({
                waterBodyId: body._id as Id<'waterBodies'>,
                reason: reason as 'landowner_request',
                ...(removalNote !== '' ? { note: removalNote } : {}),
              });
              onResult({ tone: 'ok', text: 'Taken off the map.' });
            }}
          />
          <p className="text-foreground-muted text-xs">
            Admin only, and reversible — the row, its reports and its hazards all survive. A
            re-import preserves the removal rather than quietly putting the lake back.
          </p>
        </>
      ) : null}
    </ToolCard>
  );
}
