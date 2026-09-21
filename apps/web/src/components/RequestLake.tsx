import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  ADMIT_KNOWN_WATER_MARGIN_M,
  describeRequestOutcome,
  MAX_REQUEST_NAME_LENGTH,
  MAX_REQUEST_NOTE_LENGTH,
  type RequestKind,
  requestKindLabel,
  requestKindsFor,
  requestPrompt,
  type StandingInput,
  standingOf,
} from '@skating/core';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

/**
 * Asking for a lake (A07b PR 2 / D106–D108) — the drawer's buttons and the map's prompt.
 *
 * **`RequestButtons`** sits under the standing notice on any lake and offers exactly the kinds the
 * lake's standing admits (`requestKindsFor`): bring a dormant lake back, contest a no-access
 * ruling, restore a removed one, or — on any lake — a landowner's takedown. Each opens the same
 * one-sentence dialog. Once asked, the row reads back the ask and, later, the moderator's answer.
 *
 * **`AdmitPrompt`** is what a right-click on water with no body opens. It first asks the server
 * whether we already hold a body there (a dormant or removed lake is reachable now, so the tap is
 * about *it*), and navigates to the lake if so; otherwise it takes the sentence and files an
 * `admit`, which the catalog resolver picks up.
 */

function messageOf(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data.message ?? 'Something went wrong.');
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function knownWaterOf(err: unknown): Id<'waterBodies'> | null {
  if (!(err instanceof ConvexError)) return null;
  const data = err.data as { code?: string; waterBodyId?: string };
  return data?.code === 'known_water' && data.waterBodyId
    ? (data.waterBodyId as Id<'waterBodies'>)
    : null;
}

export function RequestButtons({
  body,
}: {
  body: StandingInput & { _id: string; centroid: { lat: number; lng: number } };
}) {
  const kinds = requestKindsFor(standingOf(body));
  const mine = useQuery(api.corpusRequests.listMineForBody, {
    waterBodyId: body._id as Id<'waterBodies'>,
  });
  const counts = useQuery(api.corpusRequests.openCountsForBody, {
    waterBodyId: body._id as Id<'waterBodies'>,
  });
  const create = useMutation(api.corpusRequests.create);
  const [asking, setAsking] = useState<RequestKind | null>(null);

  if (kinds.length === 0) return null;
  const latest = mine?.[0];
  return (
    <>
      <RequestButtonsView
        kinds={kinds}
        pendingKind={mine?.find((r) => r.status === 'open')?.kind}
        outcome={latest ? describeRequestOutcome(latest) : null}
        counts={counts ?? {}}
        onAsk={setAsking}
      />
      {asking ? (
        <RequestDialog
          kind={asking}
          onClose={() => setAsking(null)}
          onSubmit={async (note, name) => {
            await create({
              kind: asking,
              coord: body.centroid,
              waterBodyId: body._id as Id<'waterBodies'>,
              ...(note ? { note } : {}),
              ...(name ? { name } : {}),
            });
          }}
        />
      ) : null}
    </>
  );
}

/** The view half — Convex-free, so the rules render under test. */
export function RequestButtonsView({
  kinds,
  pendingKind,
  outcome,
  counts,
  onAsk,
}: {
  kinds: readonly RequestKind[];
  /** The kind of the viewer's own open ask, if any — its button is disabled and the line says so. */
  pendingKind?: RequestKind | undefined;
  /** The moderator's answer to the viewer's latest ask, once there is one. */
  outcome: string | null;
  /** Distinct people with an open ask, per kind — shown beside the button. */
  counts: Partial<Record<RequestKind, number>>;
  onAsk: (kind: RequestKind) => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="request-lake">
      {pendingKind ? (
        <p className="text-muted-foreground text-sm">
          You asked — <em>{requestKindLabel(pendingKind).toLowerCase()}</em> — and it’s with the
          moderators.
        </p>
      ) : outcome ? (
        <p className="text-muted-foreground text-sm">{outcome}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {kinds.map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant={kind === 'takedown' ? 'ghost' : 'outline'}
            // A bay ask is per bay, not per lake (the server's rule): a second bay is a second ask.
            disabled={pendingKind === kind && kind !== 'name_bay'}
            onClick={() => onAsk(kind)}
          >
            {requestKindLabel(kind)}
            {(counts[kind] ?? 0) > 0 ? (
              <span className="ml-1.5 font-mono text-xs opacity-70">{counts[kind]}</span>
            ) : null}
          </Button>
        ))}
      </div>
    </div>
  );
}

function RequestDialog({
  kind,
  onClose,
  onSubmit,
}: {
  kind: RequestKind;
  onClose: () => void;
  onSubmit: (note: string, name?: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const prompt = requestPrompt(kind);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{prompt.title}</DialogTitle>
          <DialogDescription>{prompt.description}</DialogDescription>
        </DialogHeader>
        {/* A bay ask names the bay (D201): the name is the question a moderator answers. */}
        {prompt.name ? (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={prompt.name.placeholder}
            maxLength={MAX_REQUEST_NAME_LENGTH}
            aria-label={prompt.name.label}
          />
        ) : null}
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={prompt.placeholder}
          maxLength={MAX_REQUEST_NOTE_LENGTH}
          aria-label="Your note to the moderators"
        />
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || (prompt.name !== undefined && name.trim().length === 0)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSubmit(note.trim(), prompt.name ? name.trim() : undefined);
                onClose();
              } catch (err) {
                setError(messageOf(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Sending…' : 'Send to the moderators'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The map's prompt for a right-click on water we may not hold. Resolves the coordinate first: a
 * body under it — active, dormant or removed — is what the click was about, and the lake's own
 * drawer has the right ask. Only open water gets the admit form.
 */
export function AdmitPrompt({
  coord,
  onClose,
}: {
  coord: { lat: number; lng: number };
  onClose: () => void;
}) {
  const navigate = useNavigate();
  // The same 50 m the server's `known_water` refusal uses — not the report form's 300 m parking
  // buffer, which would route every press within a lot's walk of a lake to that lake and never
  // open the form for the pond next door.
  const resolved = useQuery(api.waterBodies.resolveBodyForCoord, {
    coord,
    bufferMeters: ADMIT_KNOWN_WATER_MARGIN_M,
  });
  const create = useMutation(api.corpusRequests.create);

  // A body under the click is what the click was about: hand off to its drawer.
  useEffect(() => {
    if (resolved) {
      onClose();
      navigate({ to: '/water/$id', params: { id: resolved.waterBodyId } });
    }
  }, [resolved, onClose, navigate]);

  if (resolved === undefined || resolved) return null;
  return (
    <RequestDialog
      kind="admit"
      onClose={onClose}
      onSubmit={async (note) => {
        try {
          await create({ kind: 'admit', coord, ...(note ? { note } : {}) });
        } catch (err) {
          const known = knownWaterOf(err);
          if (known) {
            onClose();
            navigate({ to: '/water/$id', params: { id: known } });
            return;
          }
          throw err;
        }
      }}
    />
  );
}
