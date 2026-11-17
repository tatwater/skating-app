import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { type LatLng, MAX_PUT_IN_NAME_LENGTH } from '@skating/core';
import { useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { type SetBanner, ToolCard } from './adminUi';
import { LEGACY_WORDS } from './legacyWords';
import { ReasonDialog } from './ReasonDialog';
import { useSaidMutation } from './said';

/**
 * Put-ins (Phase 04, decision #7) — the existing mutations, on the canvas that shows where they are.
 *
 * **This card used to be three counts and a link reading "Place and hide pins on the public map →".**
 * There was no such control on the public map; `putIns.setOfficial` and `putIns.hide` had shipped in
 * Phase 04 with a comment deferring the operator UI to Phase 07 and had zero callers in either app
 * since. The link's destination was a moderator panel that links back here, so following the
 * instruction returned you to the card that gave it.
 *
 * Placement is armed here and clicked on the editor canvas rather than on the public map, which is
 * where every other placement tool on this page already lives — the camera is locked to this lake
 * (Decision 5), so a click cannot land on the water next door.
 *
 * **Hiding is a list action, not a click on the pin.** A pin is 6 px, OSM contributes clusters of
 * them, and hiding is destructive-ish and takes a mandatory reason — so it wants an unambiguous row
 * with a name on it, not a target you might miss by three pixels.
 *
 * **Making a mapped launch official is a list action too** (B01-3o): `putIns.promote` makes the row
 * itself official — its point, bay, lot and walk kept — as the console's Access tab does. Placing an
 * official point on top of it instead (`setOfficial`) inserted a second launch beside the first, so
 * placing stays for a point no row stands on.
 */
export function PutInTool({
  waterBodyId,
  putIns,
  armed,
  onArm,
  point,
  onClearPoint,
  onResult,
}: {
  waterBodyId: Id<'waterBodies'>;
  /** Each launch; `id` on a stored row (a derived cluster has none to make official). */
  putIns: readonly { id?: string; coord: LatLng; source: string; name?: string }[];
  armed: boolean;
  onArm: (on: boolean) => void;
  point: LatLng | null;
  onClearPoint: () => void;
  onResult: SetBanner;
}) {
  const setOfficial = useSaidMutation(api.putIns.setOfficial);
  const hide = useSaidMutation(api.putIns.hide);
  const promote = useSaidMutation(api.putIns.promote);
  // The row being made official: one at a time, so a second press can't send a second write.
  const [promoting, setPromoting] = useState<string | null>(null);

  async function makeOfficial(putInId: string) {
    if (promoting !== null) return;
    setPromoting(putInId);
    try {
      // No name is sent: the row keeps its own, and a compass fallback is never stored as one.
      await promote({ putInId: putInId as Id<'putIns'> });
      onResult({ tone: 'ok', text: LEGACY_WORDS.madeOfficial });
    } catch {
      // Refused: said in its toast (the net, D268).
    } finally {
      setPromoting(null);
    }
  }
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const official = putIns.filter((p) => p.source === 'official').length;
  const osm = putIns.filter((p) => p.source === 'osm').length;
  const derived = putIns.filter((p) => p.source === 'derived').length;

  async function save() {
    if (!point) return;
    setBusy(true);
    try {
      await setOfficial({
        waterBodyId,
        coord: point,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      onClearPoint();
      setName('');
      onResult({ tone: 'ok', text: 'Official put-in placed.' });
    } catch {
      // Refused: said in its toast (the net, D268).
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolCard title="Put-ins">
      <p className="text-foreground-muted text-sm">
        {official} official · {osm} from OSM · {derived} derived from reports.
      </p>

      {putIns.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {putIns.map((p) => (
            <li
              key={`${p.coord.lat},${p.coord.lng}`}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate text-foreground-muted">
                {p.name ?? 'Unnamed launch'} — {p.source}
              </span>
              {p.id !== undefined && p.source !== 'official' ? (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={promoting !== null}
                  onClick={() => void makeOfficial(p.id as string)}
                >
                  {LEGACY_WORDS.makeOfficial}
                </Button>
              ) : null}
              <ReasonDialog
                trigger={
                  <Button variant="ghost" size="xs">
                    Hide
                  </Button>
                }
                title="Hide this put-in"
                description="Writes a suppression row at this coordinate, so it stays hidden even after the derived clusters are recomputed. Reversible only by an admin."
                confirmLabel="Hide"
                confirmVariant="secondary"
                onConfirm={async (reason) => {
                  // Refused: the net says it in a toast and rejects, so the dialog stays open.
                  await hide({ waterBodyId, coord: p.coord, reason });
                  onResult({ tone: 'ok', text: 'Put-in hidden.' });
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-2 border-border border-t pt-2">
        <Button
          variant={armed ? 'default' : 'outline'}
          size="sm"
          className="self-start"
          onClick={() => onArm(!armed)}
        >
          {armed ? 'Click the map…' : point ? 'Pick a different spot' : 'Place an official put-in'}
        </Button>
        {point ? (
          <>
            <p className="text-foreground-muted text-xs">
              {point.lat.toFixed(5)}, {point.lng.toFixed(5)} — drawn hollow until you save.
            </p>
            <Input
              placeholder="Name (optional) — e.g. Town Beach"
              value={name}
              // The server's own cap on a launch's name, from the one definition.
              maxLength={MAX_PUT_IN_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save put-in'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onClearPoint();
                  setName('');
                }}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : null}
        <p className="text-foreground-muted text-xs">
          An official marker outranks OSM and the derived clusters. Leave the name blank and it
          renders by compass bearing, the same as a derived launch.
        </p>
      </div>
    </ToolCard>
  );
}
