import { api } from '@skating/convex/api';
import { ADMIT_KNOWN_WATER_MARGIN_M, MAX_REQUEST_NOTE_LENGTH } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/kit/dialog';
import { Note } from '@/components/kit/note';
import { Textarea } from '@/components/kit/textarea';
import { useAnalytics } from '@/lib/analytics';
import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { INK_PRIMARY } from '../styles';

/**
 * Request a lake (board 3.13): a click — left or right — on water the map doesn't list. The map
 * leaves the coordinate in its store (`pendingMapClick`, never the URL); this resolves it first,
 * because a body we already hold under the click (a dormant or removed lake) is what the click was
 * about and its own page has the right ask. Only open water gets the form, which files an `admit`.
 *
 * **The coordinate never reaches a URL or an analytics event** (D242, D240) — it's shown to the
 * skater so they can see what they're pointing at, and sent to the moderators with the note.
 * The title asks to add the water; it never says the water is skateable (D3).
 */

type Coord = { lat: number; lng: number };

/** `43.6317° N, 72.0859° W` — four places, about 10 m, which is what a click can claim. */
export function formatCoord({ lat, lng }: Coord): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lng).toFixed(4)}° ${ew}`;
}

export interface RequestLakeViewProps {
  coord: Coord;
  note: string;
  error: string | null;
  pending: boolean;
  container?: HTMLElement | null;
  onNoteChange: (note: string) => void;
  onSend: () => void;
  onClose: () => void;
}

export function RequestLakeView({
  coord,
  note,
  error,
  pending,
  container,
  onNoteChange,
  onSend,
  onClose,
}: RequestLakeViewProps) {
  const noteId = useId();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-slot="request-lake"
        className="w-[min(25rem,calc(100vw-2rem))]"
        {...(container !== undefined ? { container } : {})}
      >
        <DialogHeader>
          <span className="text-kick leading-none font-medium tracking-head text-fg3 uppercase">
            Water we don’t list
          </span>
          <DialogTitle className="text-disp tracking-disp">Ask us to add it</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="m-0 text-row text-fg1 [text-wrap:pretty]">
            Say what it is and how you reach it. A moderator will look it up in the catalog and add
            it with its real outline.
          </p>
          <span
            data-slot="request-coord"
            className="font-(family-name:--family-mono) text-mono-sm text-fg2"
          >
            {formatCoord(coord)}
          </span>
          <label htmlFor={noteId} className="sr-only">
            Your note to the moderators
          </label>
          <Textarea
            id={noteId}
            className="ph-no-capture"
            data-attr="request-lake-note"
            rows={4}
            maxLength={MAX_REQUEST_NOTE_LENGTH}
            value={note}
            placeholder="A pond behind the school; the trail from the parking lot reaches the shore."
            onChange={(e) => onNoteChange(e.target.value)}
          />
          {error !== null && (
            <Note tone="warn" role="alert">
              {error}
            </Note>
          )}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" data-attr="request-lake-cancel" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            className={INK_PRIMARY}
            data-attr="request-lake-send"
            loading={pending}
            onClick={onSend}
          >
            Send to the moderators
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function knownWaterOf(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: string; waterBodyId?: string } | null;
  return data?.code === 'known_water' && data.waterBodyId ? data.waterBodyId : null;
}

function messageOf(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    if (typeof data === 'string') return data;
    if (data?.message) return data.message;
  }
  return 'Couldn’t send that. Check your connection and try again.';
}

/** The form for one pending click. Keyed by the click, so a new click starts a fresh note. */
function RequestForCoord({
  coord,
  onOpenLake,
  onClose,
}: {
  coord: Coord;
  onOpenLake: (waterBodyId: string) => void;
  onClose: () => void;
}) {
  const { capture } = useAnalytics();
  // The same 50 m margin the server's `known_water` refusal uses.
  const resolved = useQuery(api.waterBodies.resolveBodyForCoord, {
    coord,
    bufferMeters: ADMIT_KNOWN_WATER_MARGIN_M,
  });
  const create = useMutation(api.corpusRequests.create);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // A body under the click is what the click was about: its page has the asks its standing allows.
  const handedOff = useRef(false);
  useEffect(() => {
    if (!resolved || handedOff.current) return;
    handedOff.current = true;
    onOpenLake(resolved.waterBodyId);
  }, [resolved, onOpenLake]);

  if (resolved !== null) return null;

  const send = async () => {
    setPending(true);
    setError(null);
    try {
      await create({ kind: 'admit', coord, ...(note.trim() ? { note: note.trim() } : {}) });
      // The kind only: never the note, never the coordinate.
      capture('water_body_request_submitted', { request_kind: 'admit' });
      onClose();
    } catch (e) {
      const known = knownWaterOf(e);
      if (known) {
        onOpenLake(known);
        return;
      }
      setError(messageOf(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <RequestLakeView
      coord={coord}
      note={note}
      error={error}
      pending={pending}
      onNoteChange={setNote}
      onSend={() => void send()}
      onClose={onClose}
    />
  );
}

/**
 * Watches the map's pending click and opens the request for it. Mounted wherever the map takes
 * requests (Explore, a lake). Closing clears the click, so the next one opens fresh.
 */
export function RequestLakeHost({ onOpenLake }: { onOpenLake: (waterBodyId: string) => void }) {
  const pending = useSkaterMapStore((s) => s.pendingMapClick);
  const clear = () => useSkaterMapStore.getState().setPendingMapClick(null);
  if (pending === null) return null;
  return (
    <RequestForCoord
      key={`${pending.lat},${pending.lng}`}
      coord={pending}
      onOpenLake={(id) => {
        clear();
        onOpenLake(id);
      }}
      onClose={clear}
    />
  );
}

/**
 * `/?act=request` (a link to the flow with no click in hand): says how to start one. The request
 * itself opens from the map click, through `RequestLakeHost`.
 */
export function RequestLakePane() {
  return (
    <p data-slot="request-lake-hint" className="m-0 text-row text-fg2 [text-wrap:pretty]">
      Click water we don’t list on the map to ask us to add it. Right-click works too.
    </p>
  );
}
