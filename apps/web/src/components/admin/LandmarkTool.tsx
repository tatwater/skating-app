import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  LANDMARK_KIND_LABELS,
  LANDMARK_KINDS,
  type LandmarkKind,
  type LatLng,
  landmarkNameKey,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { errorText, ToolCard } from './adminUi';
import { DismissPlaceNameDialog } from './DismissPlaceNameDialog';
import { ReasonDialog } from './ReasonDialog';

export type EditorLandmark = FunctionReturnType<typeof api.landmarks.listForEditor>[number];

type SetBanner = (banner: { tone: 'ok' | 'error'; text: string } | null) => void;

/** How many rows the list shows before asking for a filter — Champlain has five hundred. */
const LIST_LIMIT = 40;

/** The kinds that can become a bay: water named as a place. An island or a town never can. */
const PROMOTABLE: ReadonlySet<LandmarkKind> = new Set(['bay', 'narrows', 'other']);

const SOURCE_LABELS: Record<EditorLandmark['source'], string> = {
  osm: 'OSM',
  gnis: 'GNIS',
  corpus: 'corpus',
  moderator: 'moderator',
  proposal: 'skater',
};

function splitAliases(text: string): string[] {
  return text
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

function KindSelect({
  value,
  onChange,
  id,
}: {
  value: LandmarkKind;
  onChange: (kind: LandmarkKind) => void;
  id?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as LandmarkKind)}>
      <SelectTrigger id={id} size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LANDMARK_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {LANDMARK_KIND_LABELS[kind]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Named landmarks (D202) — the labels a lake is steered by: islands, points, reference bays,
 * narrows, river mouths, bridges, marinas, shore towns and camps.
 *
 * Most rows arrive from the ETL; this card is where a moderator fixes one (rename, re-kind, move,
 * add a spelling), takes one down, drops a new one the catalogs never had ("Bird Poop Rock"), or
 * **promotes** one to a bay when its reports show skaters now skate it (D202's rule) — which hands
 * the name to the chord tool, and the save retires the landmark in the same write.
 *
 * Every edit marks the row as a moderator's, so the next ETL run leaves its name, kind and point
 * alone. The list is filtered rather than paged: a giant holds hundreds, and a moderator is always
 * looking for one by name.
 */
export function LandmarkTool({
  waterBodyId,
  landmarks,
  armed,
  onArm,
  point,
  onClearPoint,
  onFocus,
  onPromote,
  onPlacePoint,
  onResult,
}: {
  waterBodyId: Id<'waterBodies'>;
  landmarks: readonly EditorLandmark[] | undefined;
  armed: boolean;
  onArm: (on: boolean) => void;
  point: LatLng | null;
  onClearPoint: () => void;
  onFocus: (landmark: EditorLandmark) => void;
  onPromote: (landmark: EditorLandmark) => void;
  /** Put the drop form's point here and show it — a skater's proposed spot. */
  onPlacePoint: (point: LatLng) => void;
  onResult: SetBanner;
}) {
  const create = useMutation(api.landmarks.create);
  const update = useMutation(api.landmarks.update);
  const remove = useMutation(api.landmarks.remove);
  const restore = useMutation(api.landmarks.restore);
  const approveRequest = useMutation(api.corpusRequests.approve);
  const declineRequest = useMutation(api.corpusRequests.decline);
  // What skaters have named on this lake that no map has (D202's proposal lane).
  const proposals = useQuery(api.corpusRequests.openLandmarkRequestsForBody, { waterBodyId });
  // What the community's emails name on this lake that no landmark took (the Place names queue).
  const corpusNames = useQuery(api.corpusPlaceNames.openForBody, { waterBodyId });
  const fileAsSpelling = useMutation(api.corpusPlaceNames.fileAsSpelling);

  const [filter, setFilter] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);
  /** The row being edited, or moved — a move takes the next map click as its new point. */
  const [editing, setEditing] = useState<EditorLandmark | null>(null);
  const [moving, setMoving] = useState<Id<'bodyLandmarks'> | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<LandmarkKind>('other');
  const [aliases, setAliases] = useState('');
  const [busy, setBusy] = useState(false);
  /** The proposal the drop form is answering — saving the landmark approves every ask for it. */
  const [answering, setAnswering] = useState<Id<'waterBodyRequests'> | null>(null);
  /** The corpus name the drop form is placing — saving the landmark marks it placed. */
  const [placingName, setPlacingName] = useState<Id<'corpusPlaceNames'> | null>(null);
  /** The corpus name being filed as another spelling, and the landmark chosen for it. */
  const [spelling, setSpelling] = useState<Id<'corpusPlaceNames'> | null>(null);

  const rows = landmarks ?? [];
  const live = rows.filter((l) => l.removedAt === undefined);
  const key = landmarkNameKey(filter);
  const matching = rows
    .filter((l) => showRemoved || l.removedAt === undefined)
    .filter(
      (l) =>
        !key ||
        [l.name, ...l.aliases].some((n) => landmarkNameKey(n).includes(key)) ||
        LANDMARK_KIND_LABELS[l.kind].toLowerCase().includes(filter.trim().toLowerCase()),
    );
  const shown = matching.slice(0, LIST_LIMIT);

  const reset = () => {
    setEditing(null);
    setMoving(null);
    setAnswering(null);
    setPlacingName(null);
    setSpelling(null);
    setName('');
    setKind('other');
    setAliases('');
    onClearPoint();
  };

  const run = async (write: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await write();
      onResult({ tone: 'ok', text: ok });
      return true;
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // A move is armed like a drop, and the click that lands is the new point. Keyed on the click
  // alone: the callbacks are fresh each render, and re-running on them would re-send the move.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once per landed click
  useEffect(() => {
    if (!moving || !point) return;
    const id = moving;
    setMoving(null);
    onClearPoint();
    void run(() => update({ landmarkId: id, point }), 'Moved.');
  }, [moving, point]);

  // A name or proposal the form is answering can be decided elsewhere meanwhile (dismissed here, by
  // a colleague, on the triage page); the form lets go of it rather than save against a closed row.
  useEffect(() => {
    if (placingName && corpusNames && !corpusNames.some((c) => c._id === placingName)) {
      setPlacingName(null);
    }
    if (answering && proposals && !proposals.some((p) => p.requestId === answering)) {
      setAnswering(null);
    }
  }, [placingName, corpusNames, answering, proposals]);

  const startEdit = (l: EditorLandmark) => {
    reset();
    setEditing(l);
    setName(l.name);
    setKind(l.kind);
    setAliases(l.aliases.join(', '));
  };

  return (
    <ToolCard title="Landmarks">
      <p className="text-foreground-muted text-sm">
        {live.length} on the map — the names skaters steer by. Labels only; a landmark has no page.
      </p>

      <div className="flex items-center gap-2">
        <Input
          placeholder="Find by name, alias or kind"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="flex shrink-0 items-center gap-1 text-foreground-muted text-xs">
          <input
            type="checkbox"
            checked={showRemoved}
            onChange={(e) => setShowRemoved(e.target.checked)}
            className="size-3.5"
          />
          Removed
        </label>
      </div>

      {shown.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {shown.map((l) => (
            <li key={l._id} className="flex flex-wrap items-center justify-between gap-x-2">
              <button
                type="button"
                className={`min-w-0 flex-1 truncate text-left underline-offset-2 hover:underline ${
                  l.removedAt !== undefined ? 'text-foreground-muted line-through' : ''
                }`}
                onClick={() => onFocus(l)}
              >
                {l.name}
                <span className="text-foreground-muted">
                  {' '}
                  — {LANDMARK_KIND_LABELS[l.kind].toLowerCase()} · {SOURCE_LABELS[l.source]}
                  {l.corpusMessages ? ` · ${l.corpusMessages} mentions` : ''}
                  {l.moderatorEditedAt !== undefined ? ' · edited' : ''}
                </span>
              </button>
              <span className="flex shrink-0 gap-1">
                {l.removedAt !== undefined ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => void run(() => restore({ landmarkId: l._id }), 'Restored.')}
                  >
                    Restore
                  </Button>
                ) : (
                  <>
                    <Button variant="ghost" size="xs" onClick={() => startEdit(l)}>
                      Edit
                    </Button>
                    <Button
                      variant={moving === l._id ? 'default' : 'ghost'}
                      size="xs"
                      onClick={() => {
                        reset();
                        setMoving(l._id);
                        onFocus(l);
                        onArm(true);
                      }}
                    >
                      {moving === l._id ? 'Click the map…' : 'Move'}
                    </Button>
                    {PROMOTABLE.has(l.kind) ? (
                      <Button variant="ghost" size="xs" onClick={() => onPromote(l)}>
                        Draw as bay
                      </Button>
                    ) : null}
                    <ReasonDialog
                      trigger={
                        <Button variant="ghost" size="xs">
                          Remove
                        </Button>
                      }
                      title={`Remove “${l.name}”`}
                      description="Takes the label off the map and out of the report sheet. A re-run of the import will not bring it back; Restore will."
                      confirmLabel="Remove"
                      confirmVariant="secondary"
                      onConfirm={async (reason) => {
                        await run(() => remove({ landmarkId: l._id, reason }), 'Removed.');
                      }}
                    />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-foreground-muted text-sm">
          {rows.length === 0 ? 'No landmarks on this lake yet.' : 'Nothing matches.'}
        </p>
      )}
      {matching.length > shown.length ? (
        <p className="text-foreground-muted text-xs">
          {matching.length - shown.length} more — narrow the filter.
        </p>
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-2 border-border border-t pt-2">
          <p className="text-sm">Editing “{editing.name}”</p>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <KindSelect value={kind} onChange={setKind} />
          <Input
            placeholder="Other spellings, comma-separated"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            aria-label="Other spellings"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                const saved = await run(
                  () =>
                    update({
                      landmarkId: editing._id,
                      name,
                      kind,
                      aliases: splitAliases(aliases),
                    }),
                  'Saved.',
                );
                if (saved) reset();
              }}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="outline" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {corpusNames && corpusNames.length > 0 ? (
        <div className="flex flex-col gap-1 border-border border-t pt-2">
          <p className="text-sm">Named in the community’s emails</p>
          <ul className="space-y-1 text-sm">
            {corpusNames.map((c) => (
              <li key={c._id} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center justify-between gap-x-2">
                  <span className="min-w-0 flex-1 truncate">
                    {c.name}
                    <span className="text-foreground-muted">
                      {' '}
                      — {c.messages} {c.messages === 1 ? 'mention' : 'mentions'}
                      {c.aliases.length > 0 ? ` · also ${c.aliases.join(', ')}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {/* Already a landmark (the emails did not say which): nothing to place, only
                        the landmark to choose. */}
                    {c.alreadyNamed ? null : (
                      <Button
                        variant={placingName === c._id ? 'default' : 'ghost'}
                        size="xs"
                        onClick={() => {
                          reset();
                          setName(c.name);
                          setAliases(c.aliases.join(', '));
                          setPlacingName(c._id);
                          onArm(true);
                        }}
                      >
                        {placingName === c._id && !point ? 'Click the map…' : 'Place it'}
                      </Button>
                    )}
                    <Button
                      variant={spelling === c._id ? 'default' : 'ghost'}
                      size="xs"
                      disabled={live.length === 0}
                      onClick={() => setSpelling(spelling === c._id ? null : c._id)}
                    >
                      {c.alreadyNamed ? 'Which one?' : 'Already here'}
                    </Button>
                    <DismissPlaceNameDialog
                      id={c._id}
                      name={c.name}
                      onDone={() => onResult({ tone: 'ok', text: `Dismissed “${c.name}”.` })}
                      trigger={
                        <Button variant="ghost" size="xs">
                          Dismiss
                        </Button>
                      }
                    />
                  </span>
                </div>
                {spelling === c._id ? (
                  <select
                    aria-label={`The landmark “${c.name}” is another spelling of`}
                    className="rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                    defaultValue=""
                    onChange={(e) => {
                      const landmarkId = e.target.value as Id<'bodyLandmarks'>;
                      if (!landmarkId) return;
                      setSpelling(null);
                      void run(
                        () => fileAsSpelling({ id: c._id, landmarkId }),
                        `Filed “${c.name}” as another spelling.`,
                      );
                    }}
                  >
                    <option value="">Another spelling of…</option>
                    {[...live]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((l) => (
                        <option key={l._id} value={l._id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {proposals && proposals.length > 0 ? (
        <div className="flex flex-col gap-1 border-border border-t pt-2">
          <p className="text-sm">Named by skaters</p>
          <ul className="space-y-1 text-sm">
            {proposals.map((p) => (
              <li key={p.requestId} className="flex flex-wrap items-center justify-between gap-x-2">
                <span className="min-w-0 flex-1 truncate">
                  {p.name}
                  <span className="text-foreground-muted">
                    {' '}
                    — {p.askers} {p.askers === 1 ? 'skater' : 'skaters'}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {p.existingLandmarkId ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => approveRequest({ requestId: p.requestId }),
                          `“${p.name}” is already a landmark — answered.`,
                        )
                      }
                    >
                      Approve
                    </Button>
                  ) : (
                    <Button
                      variant={answering === p.requestId ? 'default' : 'ghost'}
                      size="xs"
                      onClick={() => {
                        reset();
                        setName(p.name);
                        setAnswering(p.requestId);
                        onPlacePoint(p.coord);
                      }}
                    >
                      Add as landmark
                    </Button>
                  )}
                  <ReasonDialog
                    trigger={
                      <Button variant="ghost" size="xs">
                        Decline
                      </Button>
                    }
                    title={`Decline “${p.name}”`}
                    description="The skaters who named it read your note."
                    confirmLabel="Decline"
                    confirmVariant="secondary"
                    onConfirm={async (note) => {
                      await run(
                        () => declineRequest({ requestId: p.requestId, note }),
                        'Declined.',
                      );
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-border border-t pt-2">
        <Button
          variant={armed && !moving ? 'default' : 'outline'}
          size="sm"
          className="self-start"
          onClick={() => {
            setMoving(null);
            setEditing(null);
            // Answering a proposal, "pick a different spot" moves the point and keeps the name and
            // the ask; anything else starts a fresh form, so an abandoned edit's name and kind never
            // ride into a new landmark (nor an old proposal's request into an unrelated one).
            if ((!answering && !placingName) || !point) {
              setAnswering(null);
              setPlacingName(null);
              setName('');
              setKind('other');
              setAliases('');
            }
            onArm(!(armed && !moving));
          }}
        >
          {armed && !moving
            ? 'Click the map…'
            : point && !moving
              ? 'Pick a different spot'
              : 'Drop a landmark'}
        </Button>
        {point && !moving ? (
          <>
            <p className="text-foreground-muted text-xs">
              {point.lat.toFixed(5)}, {point.lng.toFixed(5)} — drawn hollow until you save.
            </p>
            <Input
              placeholder="Name — e.g. Bird Poop Rock"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Name"
            />
            <KindSelect value={kind} onChange={setKind} />
            <Input
              placeholder="Other spellings, comma-separated (optional)"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              aria-label="Other spellings"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy || !name.trim()}
                onClick={async () => {
                  const saved = await run(
                    () =>
                      create({
                        waterBodyId,
                        name,
                        kind,
                        point,
                        aliases: splitAliases(aliases),
                        ...(answering ? { requestId: answering } : {}),
                        ...(placingName ? { corpusNameId: placingName } : {}),
                      }),
                    answering
                      ? `Added “${name.trim()}” and answered the skaters who named it.`
                      : placingName
                        ? `Placed “${name.trim()}”.`
                        : `Added “${name.trim()}”.`,
                  );
                  if (saved) reset();
                }}
              >
                {busy ? 'Saving…' : 'Save landmark'}
              </Button>
              <Button size="sm" variant="outline" onClick={reset}>
                Cancel
              </Button>
            </div>
          </>
        ) : null}
        <p className="text-foreground-muted text-xs">
          Put the point where the label should sit: an island's middle, a point's tip, a river's
          mouth.
        </p>
      </div>
    </ToolCard>
  );
}
