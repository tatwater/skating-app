import { Button } from '../ui/button';
import { ReasonDialog } from './ReasonDialog';

/** One bay a lake's skaters have asked for — `corpusRequests.openBayRequestsForBody`'s row. */
export interface BayRequestRow {
  requestId: string;
  name: string;
  aliases: string[];
  /** Where the bay is, when someone said — a drawer ask carries only the lake, so none. */
  coord?: { lat: number; lng: number };
  notes: string[];
  askers: number;
  createdAt: number;
  /** A sub-area by this name already exists: the row offers approval, not a drawing. */
  drawnSubAreaId?: string;
}

/**
 * The lake editor's sub-area queue (D201): this body's open `name_bay` asks, one row per bay.
 *
 * The moderator works down the list — **Draw** hands the row to the chord tool with the name and
 * aliases prefilled and the map flown to the point; saving the bay approves the ask. A row whose
 * bay was drawn without the request in hand offers **Approve** instead. **Not a bay** declines with
 * a note the skater reads: it is a reference point, a landmark, not a place people skate to.
 * Convex-free, so the rows render under test.
 */
export function BayRequestQueue({
  rows,
  busy,
  onDraw,
  onApprove,
  onDecline,
}: {
  rows: readonly BayRequestRow[];
  /** The request currently in the chord tool, if any — its row says so instead of offering Draw. */
  busy?: string | null;
  onDraw: (row: BayRequestRow) => void;
  onApprove: (row: BayRequestRow) => Promise<void>;
  onDecline: (row: BayRequestRow, note: string) => Promise<void>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-border border-t pt-3" data-testid="bay-queue">
      <p className="text-foreground-muted text-xs">
        {rows.length === 1 ? 'One bay' : `${rows.length} bays`} skaters have asked for on this lake.
        Draw each with the chord tool; saving it answers the ask.
      </p>
      {rows.map((row) => (
        <div key={row.requestId} className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-foreground">
              {row.name}
              {row.askers > 1 ? (
                <span className="ml-2 font-mono text-foreground-muted text-xs">
                  {row.askers} people
                </span>
              ) : null}
              {row.aliases.length > 0 ? (
                <span className="text-foreground-muted"> · {row.aliases.join(', ')}</span>
              ) : null}
            </span>
            <span className="flex shrink-0 gap-1">
              {row.drawnSubAreaId ? (
                <Button size="sm" onClick={() => void onApprove(row)}>
                  Approve
                </Button>
              ) : busy === row.requestId ? (
                <span className="text-foreground-muted text-xs">drawing…</span>
              ) : (
                <Button size="sm" onClick={() => onDraw(row)}>
                  Draw
                </Button>
              )}
              <ReasonDialog
                trigger={
                  <Button size="sm" variant="ghost">
                    Not a bay
                  </Button>
                }
                title={`Decline — ${row.name}`}
                description="A bay is a sub-area only when skaters go to it and mostly skate it; otherwise it is a reference point, like an island. The skater reads your note."
                confirmLabel="Decline"
                confirmVariant="secondary"
                requireReason={true}
                reasonPlaceholder="Skaters name it for directions, not as a destination — it will be a map label."
                onConfirm={(note) => onDecline(row, note)}
              />
            </span>
          </div>
          {row.notes.map((note, index) => (
            <blockquote
              // Two askers can leave the same note; the position is the identity here.
              // biome-ignore lint/suspicious/noArrayIndexKey: notes have no id and never reorder.
              key={index}
              className="border-border border-l-2 pl-2 text-foreground-muted text-xs"
            >
              {note}
            </blockquote>
          ))}
        </div>
      ))}
    </div>
  );
}
