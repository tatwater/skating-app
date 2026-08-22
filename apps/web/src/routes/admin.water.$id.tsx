import { api } from '@skating/convex/api';
import type { Doc, Id } from '@skating/convex/dataModel';
import {
  BODY_FEATURE_TYPE_LABELS,
  BODY_FEATURE_TYPES,
  type BodyFeatureType,
  DEFAULT_SAMPLE_SPACING_KM,
  DEPTH_SOURCE_LABELS,
  type DepthSource,
  displayScore,
  formatDepthFeet,
  formatSeason,
  isShallowDepth,
  type LatLng,
  minVisibleZoom,
  type PromotionTarget,
  referenceLinkError,
  SATELLITE_MIN_AREA_SQM,
  type SatelliteImageryMode,
  satelliteImageryAvailable,
  seasonOf,
  snapToEdge,
  suggestSamplePoints,
  timingWindowLabel,
} from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { LakeEditorMap } from '../components/admin/LakeEditorMap';
import { PostedAccessTool } from '../components/admin/PostedAccessEditor';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { WaterBodyTimeline } from '../components/admin/WaterBodyTimeline';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { createPolygonDraw, type PolygonDrawControl, parsePastedPolygon } from '../lib/polygonDraw';

/**
 * The per-lake editor (N2 / D61) — **one lake, one canvas, every per-body lever**.
 *
 * Before this, `/admin` was entirely tables and the map lived only in the skater tree. Curation
 * therefore meant holding a lake in your head across a queue row, a CSV and an internal mutation,
 * and the resulting mis-matches (five of them, from the Phase-2.5 seed) were invisible because no
 * screen listed what had been curated. This is the screen.
 *
 * The camera is locked to the body (Decision 5) — see `LakeEditorMap` for why that's the feature
 * rather than a guard rail. Everything else here is a tool panel beside it. Three of the seven tools
 * needed no new backend at all; the server hard-gates every mutation regardless of what this renders.
 */
export const Route = createFileRoute('/admin/water/$id')({ component: LakeEditor });

function LakeEditor() {
  const { id } = Route.useParams();
  const waterBodyId = id as Id<'waterBodies'>;
  const result = useQuery(api.waterBodies.get, { waterBodyId });
  const body = result?.available ? result.body : null;

  const subAreas = useQuery(api.subAreas.listForBody, { waterBodyId });
  const putIns = useQuery(api.putIns.listForBody, { waterBodyId });
  // Also read by `AccessTool` below; the Convex client dedupes identical subscriptions to one, so
  // hoisting it for the canvas costs nothing.
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId });
  const hazards = useQuery(api.hazards.listForBody, { waterBodyId });
  const features = useQuery(api.bodyFeatures.listForBody, { waterBodyId });
  const tracks = useQuery(api.gpsActivities.listTracksForBody, { waterBodyId });

  const [draft, setDraft] = useState<GeoJSON.Polygon | GeoJSON.MultiPolygon | null>(null);
  const [suggested, setSuggested] = useState<LatLng[]>([]);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [editorImagery, setEditorImagery] = useState(false);
  // The live map handle, so the lazily-created draw control can attach to the canvas. A ref on the
  // component rather than a module-level object: a module singleton outlives the route, holding a
  // removed map that the next visit's draw control would happily attach to.
  const drawTargetRef = useRef<maplibregl.Map | null>(null);
  /**
   * The by-hand body feature being authored (D79). A point and a polygon are mutually exclusive —
   * arming one clears the other — so that "Add feature" can never be ambiguous about what it will save.
   */
  const [featurePoint, setFeaturePoint] = useState<LatLng | null>(null);
  const [featureDraft, setFeatureDraft] = useState<GeoJSON.Polygon | GeoJSON.MultiPolygon | null>(
    null,
  );
  /**
   * **What the next map click means — one slot, not a boolean per tool** (N6f).
   *
   * Three tools now place a point on this canvas, and there is a single unconditional click handler
   * on the map. With a boolean each, two could be armed at once and the click would go to whichever
   * branch was written first — a bug with no error, where a lot lands as a put-in. A discriminator
   * makes "armed for something else" unrepresentable: arming any tool disarms the others by
   * construction, and each tool's button reads its own value to know whether it is the live one.
   */
  const [placing, setPlacing] = useState<'feature' | 'put_in' | 'parking' | null>(null);
  const [putInPoint, setPutInPoint] = useState<LatLng | null>(null);
  const [parkingPoint, setParkingPoint] = useState<LatLng | null>(null);

  if (result === undefined) return <AdminEmpty>Loading…</AdminEmpty>;
  if (result === null || !body) {
    return <AdminEmpty>No such water body. The link may be broken.</AdminEmpty>;
  }
  // A delisted body renders this instead of the editor, and it used to say "Restore it before
  // editing" while offering no way to restore it — the empty state was the third place in this
  // feature that named an action nobody could take. The button is here rather than in `RemovalTool`
  // because that card lives inside the editor, which is exactly what a delisted body does not get.
  if (!result.available) return <RestoreGate waterBodyId={waterBodyId} />;

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        title={body.name}
        subtitle={`${body.type}${body.states?.length ? ` · ${body.states.join(', ')}` : ''} — every per-body lever, on one canvas.`}
      />
      <Link
        to="/admin/water"
        className="text-foreground-muted text-sm underline underline-offset-2"
      >
        ← Back to the water queues
      </Link>

      {banner ? (
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            banner.tone === 'ok'
              ? 'border-border bg-surface-muted text-foreground'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
          role={banner.tone === 'error' ? 'alert' : 'status'}
        >
          {banner.text}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="relative h-[70vh] min-h-96 overflow-hidden rounded-lg border border-border">
          {/* Unmasked aerial under the editor (N6e Workstream E). Off by default: tracing against
              the vector map is the ordinary case, and a photograph is what you reach for when the
              stored shoreline and the real one disagree. */}
          <label className="absolute top-2 right-2 z-10 flex cursor-pointer items-center gap-2 rounded-md bg-background/95 px-2 py-1 text-xs shadow-lg">
            <input
              type="checkbox"
              checked={editorImagery}
              onChange={(event) => setEditorImagery(event.target.checked)}
              className="size-3.5"
            />
            Aerial
          </label>
          <LakeEditorMap
            imagery={editorImagery}
            data={{
              body: {
                _id: body._id,
                name: body.name,
                type: body.type,
                polygon: body.polygon as GeoJSON.Geometry,
                bbox: body.bbox,
              },
              subAreas: (subAreas ?? [])
                .filter((s) => !s.removed)
                .map((s) => ({
                  _id: s._id,
                  waterBodyId: body._id,
                  name: s.name,
                  polygon: s.polygon as GeoJSON.Geometry,
                  centroid: s.centroid,
                })),
              putIns: putIns ?? [],
              parkingAreas: access?.parking ?? [],
              samplePoints: body.weatherSamplePoints ?? [],
              // One draft slot on the map, shared by the two tools that produce a shape. They can't
              // both be armed — arming either clears the other — so there is never a shape on screen
              // whose owner is ambiguous.
              draftPolygon: draft ?? featureDraft,
              // Every pending point, drawn hollow — the canvas's existing "unsaved proposal"
              // convention. Which tool owns which is answered by the card holding it, each of which
              // prints its own coordinate; the map's job here is only to say "not saved yet".
              suggestedPoints: [suggested, featurePoint, putInPoint, parkingPoint]
                .flat()
                .filter((p): p is LatLng => p !== null),
            }}
            onMapClick={(coord) => {
              // One-shot: consume the click and disarm, so a stray second click can't move the point
              // an operator has already started filling a form around.
              if (placing === 'feature') setFeaturePoint(coord);
              // **Snapped in the preview, not just on save** (N6f). The server snaps a put-in to the
              // shoreline before storing it, so a raw click drawn on the canvas would promise a pin
              // where one is never going to be — and the gap is most visible for the mid-lake click
              // that most needs snapping. What you see hollow is where it lands.
              else if (placing === 'put_in')
                setPutInPoint(snapToEdge(coord, body.polygon as unknown as GeoJSON.Polygon));
              else if (placing === 'parking') setParkingPoint(coord);
              else return;
              setPlacing(null);
            }}
            onReady={(map) => {
              drawTargetRef.current = map;
            }}
          />
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto">
          <NameTool body={body} onResult={setBanner} />
          <ProminenceTool body={body} onResult={setBanner} />
          <SubAreaTool
            waterBodyId={waterBodyId}
            subAreas={subAreas ?? []}
            draft={draft}
            setDraft={setDraft}
            mapRef={drawTargetRef}
            onResult={setBanner}
          />
          <DepthTool body={body} onResult={setBanner} />
          <SamplePointTool
            body={body}
            suggested={suggested}
            setSuggested={setSuggested}
            onResult={setBanner}
          />
          {/* The three placement tools each read the one `placing` slot, so arming any of them is
              also what disarms the other two — there is no state in which a click is ambiguous. */}
          <PutInTool
            waterBodyId={waterBodyId}
            putIns={putIns ?? []}
            armed={placing === 'put_in'}
            onArm={(on) => setPlacing(on ? 'put_in' : null)}
            point={putInPoint}
            onClearPoint={() => setPutInPoint(null)}
            onResult={setBanner}
          />
          <AccessTool
            waterBodyId={waterBodyId}
            armed={placing === 'parking'}
            onArm={(on) => setPlacing(on ? 'parking' : null)}
            point={parkingPoint}
            onClearPoint={() => setParkingPoint(null)}
            onResult={setBanner}
          />
          <BodyFeatureTool
            waterBodyId={waterBodyId}
            features={features ?? []}
            draft={featureDraft}
            setDraft={setFeatureDraft}
            point={featurePoint}
            setPoint={setFeaturePoint}
            arming={placing === 'feature'}
            setArming={(on) => setPlacing(on ? 'feature' : null)}
            mapRef={drawTargetRef}
            onResult={setBanner}
          />
          <HazardTool hazards={hazards ?? []} />
          <RecurrenceTool waterBodyId={waterBodyId} onResult={setBanner} />
          <PromotionTool waterBodyId={waterBodyId} onResult={setBanner} />
          <TrackTool tracks={Array.isArray(tracks) ? [] : (tracks?.tracks ?? [])} />
          {/* What the sign says (N6e) — beside the reference links, because both are things a human
              read somewhere and typed in, and neither is derivable from the row. */}
          <ToolCard title="Posted rules">
            <PostedAccessTool body={body} onResult={setBanner} />
          </ToolCard>
          {/* Beside the links because that is what it governs: the Copernicus row in the drawer's
              link list, not the aerial reveal on the map. */}
          <SatelliteTool body={body} onResult={setBanner} />
          <ReferenceLinkTool body={body} onResult={setBanner} />
          {/* The one lever here that removes rather than refines, so it sits below all of them and
              above only the log that records it. */}
          <RemovalTool body={body} onResult={setBanner} />
          {/* Last in the column (N6c/F1): the log answers "what happened to this lake", which is a
              question you ask after looking at the levers, not before. */}
          <ToolCard title="History">
            <WaterBodyTimeline waterBodyId={waterBodyId} />
          </ToolCard>
        </div>
      </div>
    </div>
  );
}

type Banner = { tone: 'ok' | 'error'; text: string } | null;
type SetBanner = (banner: Banner) => void;

/** Turn a thrown ConvexError into the operator-facing line the server wrote. */
function errorText(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data?.message ?? 'That write was rejected.');
  }
  return 'Something went wrong — check your connection and try again.';
}

function ToolCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="font-mono text-foreground-muted text-xs uppercase tracking-widest">{title}</p>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * Which publisher's name this body displays (N7).
 *
 * **A picker, not a text field, and that is the design rather than a shortcut.** `NAME_SOURCE_RANK`
 * stores the most authoritative name — `gnis > nhd > 3dhp > osm` — and that costs 463 bodies their
 * local one: Auburn's own water supply is stored as `The Basin`, NHD's `gnis_name`, while everyone
 * calls it `Lake Auburn`. The decision here is *which claim wins*, so offering free text would
 * invite inventing a fourth name that no publisher can be pointed at, in the one field whose whole
 * value is that every name on it is traceable.
 *
 * **Choosing does not lose the other name.** `searchText` is rebuilt from the winner plus every
 * remaining claim, so both stay findable — what displays and what is searchable are different
 * questions. The caption below says so, because a moderator hesitating over "will this break
 * search?" is exactly the hesitation that leaves 463 rows unworked.
 */
function NameTool({
  body,
  onResult,
}: {
  body: {
    _id: string;
    name: string;
    nameClaims?: { source: string; value: string }[];
    confidence?: { name?: string };
  };
  onResult: SetBanner;
}) {
  const setName = useMutation(api.waterBodies.setWaterBodyName);
  const claims = body.nameClaims ?? [];
  const overridden = claims.some((c) => c.source === 'user');
  // One row per distinct name, carrying every publisher that asserted it — the dedupe is here rather
  // than in the mutation because the *storage* wants the provenance and the *reader* wants the choice.
  const options = new Map<string, string[]>();
  for (const c of claims) {
    const key = c.value;
    const sources = options.get(key);
    if (sources) sources.push(c.source);
    else options.set(key, [c.source]);
  }

  // A body every publisher agrees on has nothing to decide, and a card offering one button is noise
  // on 24,000 of 25,136 rows.
  if (options.size < 2) return null;

  return (
    <ToolCard title="Name">
      <div className="flex flex-col gap-1.5">
        {[...options].map(([value, sources]) => {
          const isCurrent = value === body.name;
          return (
            <div key={value} className="flex items-center justify-between gap-2">
              <span className="text-sm">
                <span
                  className={isCurrent ? 'font-medium text-foreground' : 'text-foreground-muted'}
                >
                  {value}
                </span>{' '}
                <span className="font-mono text-foreground-muted text-xs">
                  {sources.join(' · ')}
                </span>
              </span>
              {isCurrent ? (
                <span className="font-mono text-foreground-muted text-xs uppercase">
                  {overridden ? 'chosen' : 'ranked'}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await setName({ waterBodyId: body._id as Id<'waterBodies'>, name: value });
                      onResult({ tone: 'ok', text: `Now displaying "${value}".` });
                    } catch (err) {
                      onResult({ tone: 'error', text: errorText(err) });
                    }
                  }}
                >
                  Use this
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-foreground-muted text-sm">
        Every name here stays searchable whichever one displays. A choice overrides the catalogue
        ranking and survives the next import.
        {overridden ? (
          <>
            {' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={async () => {
                try {
                  await setName({ waterBodyId: body._id as Id<'waterBodies'>, name: null });
                  onResult({ tone: 'ok', text: 'Back to the catalogue ranking.' });
                } catch (err) {
                  onResult({ tone: 'error', text: errorText(err) });
                }
              }}
            >
              Clear the override
            </button>
            .
          </>
        ) : null}
      </p>
    </ToolCard>
  );
}

/**
 * Prominence (D49) — with a **live preview of the resulting zoom**, which is the whole difference
 * between this and the field that already existed on the body detail. `curatedBoost` is an abstract
 * number; "draws from z9" is the thing the operator is actually deciding.
 */
function ProminenceTool({
  body,
  onResult,
}: {
  body: { _id: string; surfaceAreaSqM?: number; curatedBoost?: number; minVisibleZoom?: number };
  onResult: SetBanner;
}) {
  const setCuratedBoost = useMutation(api.waterBodies.setCuratedBoost);
  const [boost, setBoost] = useState(String(body.curatedBoost ?? 0));
  const parsed = Number(boost);
  const preview = Number.isFinite(parsed)
    ? minVisibleZoom(displayScore({ surfaceAreaSqM: body.surfaceAreaSqM, curatedBoost: parsed }))
    : null;

  return (
    <ToolCard title="Prominence">
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="boost">Curated boost</Label>
          <Input
            id="boost"
            type="number"
            step="0.1"
            value={boost}
            onChange={(e) => setBoost(e.target.value)}
            className="w-28"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            if (!Number.isFinite(parsed)) return;
            try {
              await setCuratedBoost({
                waterBodyId: body._id as Id<'waterBodies'>,
                curatedBoost: parsed,
              });
              onResult({ tone: 'ok', text: 'Prominence saved.' });
            } catch (err) {
              onResult({ tone: 'error', text: errorText(err) });
            }
          }}
        >
          Save
        </Button>
      </div>
      <p className="text-foreground-muted text-sm">
        Currently draws from <span className="text-foreground">z{body.minVisibleZoom ?? '—'}</span>
        {preview !== null && preview !== body.minVisibleZoom ? (
          <>
            {' → '}
            <span className="font-medium text-foreground">z{preview}</span> after saving
          </>
        ) : null}
        .
      </p>
    </ToolCard>
  );
}

interface DepthBody {
  _id: string;
  meanDepthM?: number;
  maxDepthM?: number;
  meanDepthSource?: DepthSource;
  maxDepthSource?: DepthSource;
  depthSourceNote?: string;
}

/**
 * Lake depth (N6a / D68) — rung 1 of the ladder, and the only rung a human writes.
 *
 * **The editable fields hold operator values only, and that is a correctness rule rather than a
 * styling one** (review fix, 2026-07-31). The first cut pre-filled them from whatever the row held,
 * and `setDepth` stamped `operator` on everything it was sent — so saving a max you *did* know
 * relabelled the HydroLAKES mean sitting in the other box as a survey reading, dropped the `~` from
 * the public caption, and locked a modelled number against every future import. An automated value is
 * therefore shown as text, never as a pre-filled input, and a blank box means "no operator reading",
 * not "delete whatever is there".
 *
 * Acting on an automated value is explicit, and there are exactly two ways to do it: type your own
 * number over it, or **Reject** it — which keeps the `operator` rung as a tombstone so the import
 * can't quietly put it back, and is undone by **Restore**.
 *
 * The card also echoes each value in feet live, because the entry field is metric and every state
 * bathymetry chart in our region is in feet: that echo is the real units guard, not the 400 m ceiling.
 */
function DepthTool({ body, onResult }: { body: DepthBody; onResult: SetBanner }) {
  const setDepth = useMutation(api.waterBodies.setDepth);
  const clearOverride = useMutation(api.waterBodies.clearDepthOverride);

  // Only an `operator` value belongs in an editable box — see the note above.
  const operatorValue = (source: DepthSource | undefined, value: number | undefined) =>
    source === 'operator' && value !== undefined ? String(value) : '';
  const serverMean = operatorValue(body.meanDepthSource, body.meanDepthM);
  const serverMax = operatorValue(body.maxDepthSource, body.maxDepthM);
  const serverNote = body.depthSourceNote ?? '';

  const [mean, setMean] = useState(serverMean);
  const [max, setMax] = useState(serverMax);
  const [note, setNote] = useState(serverNote);
  // Re-sync when the server value changes under us — a `useState` initializer runs once, so without
  // this the card would keep showing what the row held when the page loaded (an ETL run, or another
  // moderator, and you are editing a stale number). Tracking the server value we last adopted keeps
  // in-progress typing intact: only a genuine server-side change resets the boxes.
  const [synced, setSynced] = useState({ mean: serverMean, max: serverMax, note: serverNote });
  if (synced.mean !== serverMean || synced.max !== serverMax || synced.note !== serverNote) {
    setSynced({ mean: serverMean, max: serverMax, note: serverNote });
    setMean(serverMean);
    setMax(serverMax);
    setNote(serverNote);
  }

  const parse = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const parsedMean = parse(mean);
  const parsedMax = parse(max);
  const invalid = Number.isNaN(parsedMean) || Number.isNaN(parsedMax);
  const echo = (value: number | undefined) =>
    value === undefined || Number.isNaN(value) ? null : ` (${formatDepthFeet(value)})`;

  /**
   * What to send for one measurement. `undefined` (omitted) leaves the stored value and its rung
   * exactly as they are, which is what an untouched box has to mean; `null` clears an operator value
   * the moderator emptied. An automated value is never touched from here — Reject does that.
   */
  const fieldArg = (parsed: number | undefined, serverValue: string) =>
    parsed !== undefined ? parsed : serverValue === '' ? undefined : null;

  // The classification the decay model will actually apply: the moderator's edits where they made
  // any, the stored value where they didn't.
  const effective = {
    ...(parsedMean !== undefined && !Number.isNaN(parsedMean)
      ? { meanDepthM: parsedMean }
      : body.meanDepthSource !== 'operator' && body.meanDepthM !== undefined
        ? { meanDepthM: body.meanDepthM }
        : {}),
    ...(parsedMax !== undefined && !Number.isNaN(parsedMax)
      ? { maxDepthM: parsedMax }
      : body.maxDepthSource !== 'operator' && body.maxDepthM !== undefined
        ? { maxDepthM: body.maxDepthM }
        : {}),
  };
  const shallow = isShallowDepth(effective);

  const measurements = [
    {
      key: 'mean' as const,
      label: 'Mean',
      value: body.meanDepthM,
      source: body.meanDepthSource,
    },
    { key: 'max' as const, label: 'Max', value: body.maxDepthM, source: body.maxDepthSource },
  ];

  const act = async (run: () => Promise<unknown>, text: string) => {
    try {
      await run();
      onResult({ tone: 'ok', text });
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
    }
  };

  return (
    <ToolCard title="Depth">
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mean-depth">Mean (m)</Label>
          <Input
            id="mean-depth"
            type="number"
            step="0.1"
            value={mean}
            onChange={(e) => setMean(e.target.value)}
            className="w-24"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="max-depth">Max (m)</Label>
          <Input
            id="max-depth"
            type="number"
            step="0.1"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            className="w-24"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={invalid}
          onClick={() =>
            act(
              () =>
                setDepth({
                  waterBodyId: body._id as Id<'waterBodies'>,
                  meanDepthM: fieldArg(parsedMean, serverMean),
                  maxDepthM: fieldArg(parsedMax, serverMax),
                  sourceNote: note.trim() || null,
                }),
              'Depth saved as a survey reading.',
            )
          }
        >
          Save
        </Button>
      </div>
      <p className="text-foreground-muted text-sm">
        Mean
        <span className="text-foreground">{echo(parsedMean) ?? ' —'}</span> · max
        <span className="text-foreground">{echo(parsedMax) ?? ' —'}</span>. Charts are usually in
        feet; divide by 3.28. Empty means <em>no reading of your own</em> — it never deletes an
        imported value.
      </p>
      {/* The note is PUBLIC: it replaces "entered by a moderator" in the caption skaters read, which is
          the whole reason to collect it. Optional — someone who simply knows the pond has nothing to
          cite, and the generic fallback honestly says we don't know the basis. */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="depth-note">Source (shown publicly)</Label>
        <Input
          id="depth-note"
          value={note}
          maxLength={160}
          placeholder="NH Fish &amp; Game bathymetry, 1998"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {/* Each stored measurement with its rung, and the one action that rung allows. An operator
          measurement with no number is a *rejection* — the tombstone that keeps the import out. */}
      <div className="flex flex-col gap-1">
        {measurements.map((m) => (
          <p key={m.key} className="text-foreground-muted text-sm">
            <span className="text-foreground">{m.label}:</span>{' '}
            {m.source === undefined ? (
              'nothing on record — the next import may fill it.'
            ) : m.value === undefined ? (
              <>
                rejected by a moderator; the import will not refill it.{' '}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    act(
                      () =>
                        clearOverride({
                          waterBodyId: body._id as Id<'waterBodies'>,
                          measurements: [m.key],
                        }),
                      `Restored the ${m.key} depth to the import.`,
                    )
                  }
                >
                  Restore
                </Button>
              </>
            ) : (
              <>
                {formatDepthFeet(m.value)} ({m.value} m) from {DEPTH_SOURCE_LABELS[m.source]}.
                {m.source !== 'operator' ? (
                  <>
                    {' '}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        act(
                          () =>
                            setDepth({
                              waterBodyId: body._id as Id<'waterBodies'>,
                              ...(m.key === 'mean' ? { meanDepthM: null } : { maxDepthM: null }),
                            }),
                          `Rejected the imported ${m.key} depth — it will not come back on a re-run.`,
                        )
                      }
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
              </>
            )}
          </p>
        ))}
      </div>

      <p className="text-foreground-muted text-sm">
        Decay treats this lake as{' '}
        <span className="text-foreground">{shallow ? 'shallow' : 'not shallow'}</span> — a shallow
        lake holds a thaw-driven hazard warning longer (D69). A{' '}
        <span className="text-foreground">shallow bay (early thaw)</span> feature does the same for
        a body with no depth on record.
      </p>
    </ToolCard>
  );
}

/**
 * Sub-areas (D60) — draw, paste, rename, delist.
 *
 * Drawing is lazy: the terra-draw import only happens when someone actually arms it, so the engine
 * never reaches a skater's bundle. Paste-GeoJSON sits beside it permanently rather than as a hidden
 * fallback — it's how a shape traced elsewhere gets in, and it's the break-glass path if the draw
 * control breaks.
 */
function SubAreaTool({
  waterBodyId,
  subAreas,
  draft,
  setDraft,
  mapRef,
  onResult,
}: {
  waterBodyId: Id<'waterBodies'>;
  subAreas: readonly {
    _id: string;
    name: string;
    aliases: string[];
    removed: boolean;
    systemDelistReason?: string;
  }[];
  draft: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  setDraft: (polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null) => void;
  mapRef: { current: maplibregl.Map | null };
  onResult: SetBanner;
}) {
  const create = useMutation(api.subAreas.create);
  const redraw = useMutation(api.subAreas.redraw);
  const rename = useMutation(api.subAreas.rename);
  const remove = useMutation(api.subAreas.remove);
  const restore = useMutation(api.subAreas.restore);

  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [paste, setPaste] = useState('');
  const [drawing, setDrawing] = useState(false);
  /** Set when the next save should *replace* an existing bay's outline rather than mint a new one. */
  const [redrawTarget, setRedrawTarget] = useState<string | null>(null);
  const controlRef = useRef<PolygonDrawControl | null>(null);

  useEffect(() => {
    return () => {
      controlRef.current?.destroy();
      controlRef.current = null;
    };
  }, []);

  const arm = async () => {
    const map = mapRef.current;
    if (!map) return;
    try {
      if (!controlRef.current) {
        controlRef.current = await createPolygonDraw(map, {
          onFinish: (polygon) => {
            setDraft(polygon);
            setDrawing(false);
          },
        });
      }
      controlRef.current.startDrawing();
      setDrawing(true);
    } catch {
      onResult({
        tone: 'error',
        text: "Couldn't load the draw tool. Paste the outline as GeoJSON instead — it does the same thing.",
      });
    }
  };

  const save = async () => {
    if (!draft) return;
    try {
      if (redrawTarget) {
        await redraw({ subAreaId: redrawTarget as Id<'waterBodySubAreas'>, polygon: draft });
        onResult({
          tone: 'ok',
          text: 'Outline replaced. Reports and hazards are being re-stamped.',
        });
      } else {
        if (!name.trim()) {
          onResult({ tone: 'error', text: 'A sub-area needs a name.' });
          return;
        }
        await create({
          waterBodyId,
          name: name.trim(),
          polygon: draft,
          ...(aliases.trim()
            ? {
                aliases: aliases
                  .split(',')
                  .map((a) => a.trim())
                  .filter(Boolean),
              }
            : {}),
        });
        onResult({ tone: 'ok', text: `Drew “${name.trim()}”.` });
        setName('');
        setAliases('');
      }
      setDraft(null);
      setRedrawTarget(null);
      controlRef.current?.clear();
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
    }
  };

  return (
    <ToolCard title="Sub-areas">
      <div className="flex flex-col gap-2">
        {subAreas.length === 0 ? (
          <p className="text-foreground-muted text-sm">
            No named bays yet. Most lakes never need one — draw them where skaters already use a
            name for part of the ice.
          </p>
        ) : (
          subAreas.map((bay) => (
            <div key={bay._id} className="flex items-center justify-between gap-2 text-sm">
              <span
                className={bay.removed ? 'text-foreground-muted line-through' : 'text-foreground'}
              >
                {bay.name}
                {bay.aliases.length > 0 ? (
                  <span className="text-foreground-muted"> · {bay.aliases.join(', ')}</span>
                ) : null}
                {/* Why the *system* retired it, when nobody clicked delist — a re-import that moved
                    the shoreline out from under the outline, or a merge name collision. It reads
                    here because here is where the redraw happens; a server log is not a surface. */}
                {bay.systemDelistReason ? (
                  <span className="block text-warning text-xs">{bay.systemDelistReason}</span>
                ) : null}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRedrawTarget(bay._id);
                    void arm();
                  }}
                >
                  Redraw
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    const next = window.prompt('New name', bay.name);
                    if (!next) return;
                    try {
                      await rename({ subAreaId: bay._id as Id<'waterBodySubAreas'>, name: next });
                      onResult({ tone: 'ok', text: 'Renamed. Labels are being re-stamped.' });
                    } catch (err) {
                      onResult({ tone: 'error', text: errorText(err) });
                    }
                  }}
                >
                  Rename
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      if (bay.removed) {
                        await restore({ subAreaId: bay._id as Id<'waterBodySubAreas'> });
                      } else {
                        await remove({ subAreaId: bay._id as Id<'waterBodySubAreas'> });
                      }
                    } catch (err) {
                      onResult({ tone: 'error', text: errorText(err) });
                    }
                  }}
                >
                  {bay.removed ? 'Restore' : 'Delist'}
                </Button>
              </span>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-2 border-border border-t pt-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bay-name">Name</Label>
          <Input
            id="bay-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Malletts Bay"
            disabled={redrawTarget !== null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bay-aliases">Aliases (comma-separated)</Label>
          <Input
            id="bay-aliases"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="Mallets Bay, Inland Sea"
            disabled={redrawTarget !== null}
          />
          <p className="text-foreground-muted text-xs">
            Aliases are what make search reach a bay — the corpus spells Malletts ten ways, and the
            northeast arm of Champlain shares no word with anything.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant={drawing ? 'secondary' : 'outline'} size="sm" onClick={arm}>
            {drawing ? 'Drawing — click the outline' : 'Draw outline'}
          </Button>
          {draft ? (
            <>
              <Button size="sm" onClick={save}>
                {redrawTarget ? 'Replace outline' : 'Save sub-area'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDraft(null);
                  setRedrawTarget(null);
                  controlRef.current?.clear();
                }}
              >
                Discard
              </Button>
            </>
          ) : null}
        </div>
        {redrawTarget ? (
          <p className="text-foreground-muted text-xs">
            Replacing an existing outline. Its name and aliases are untouched.
          </p>
        ) : null}

        <details className="text-sm">
          <summary className="cursor-pointer text-foreground-muted">Paste GeoJSON instead</summary>
          <textarea
            className="mt-2 h-24 w-full rounded-md border border-border bg-surface p-2 font-mono text-xs"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder='{"type":"Polygon","coordinates":[[…]]}'
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const parsed = parsePastedPolygon(paste);
              if (!parsed.ok) {
                onResult({ tone: 'error', text: parsed.error });
                return;
              }
              setDraft(parsed.polygon);
              setPaste('');
              onResult({ tone: 'ok', text: 'Loaded as a draft — check it on the map, then save.' });
            }}
          >
            Load as draft
          </Button>
        </details>
      </div>
    </ToolCard>
  );
}

/**
 * Weather sample points (D56 §5) — suggested, then nudged, then saved.
 *
 * The grid is computed here from the polygon the page already has, so previewing costs no round
 * trip; the server re-validates that every saved point is on the water, which is the check that
 * matters (a point on land returns a real forecast for the wrong surface).
 */
function SamplePointTool({
  body,
  suggested,
  setSuggested,
  onResult,
}: {
  body: { _id: string; polygon: unknown; weatherSamplePoints?: LatLng[] };
  suggested: LatLng[];
  setSuggested: (points: LatLng[]) => void;
  onResult: SetBanner;
}) {
  const save = useMutation(api.waterBodies.setWeatherSamplePoints);
  const [spacing, setSpacing] = useState(String(DEFAULT_SAMPLE_SPACING_KM));
  const saved = body.weatherSamplePoints ?? [];

  return (
    <ToolCard title="Weather sample points">
      <p className="text-foreground-muted text-sm">
        {saved.length === 0
          ? 'Sampling at the centroid (the default, and right for all but the giants).'
          : `${saved.length} point${saved.length === 1 ? '' : 's'} saved.`}
      </p>
      <div className="flex items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="spacing">Spacing (km)</Label>
          <Input
            id="spacing"
            type="number"
            step="1"
            value={spacing}
            onChange={(e) => setSpacing(e.target.value)}
            className="w-24"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const km = Number(spacing);
            const result = suggestSamplePoints(
              body.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon,
              Number.isFinite(km) ? km : DEFAULT_SAMPLE_SPACING_KM,
            );
            setSuggested(result.points);
            onResult({
              tone: 'ok',
              text: result.fellBackToCentroid
                ? 'No grid point landed on the water at that spacing — falling back to one point.'
                : `Suggested ${result.points.length} point${result.points.length === 1 ? '' : 's'}${result.truncated ? ' (capped)' : ''}. Hollow circles are the proposal.`,
            });
          }}
        >
          Suggest a grid
        </Button>
      </div>
      {suggested.length > 0 ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={async () => {
              try {
                await save({ waterBodyId: body._id as Id<'waterBodies'>, points: suggested });
                setSuggested([]);
                onResult({ tone: 'ok', text: 'Sample points saved.' });
              } catch (err) {
                onResult({ tone: 'error', text: errorText(err) });
              }
            }}
          >
            Save {suggested.length}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSuggested([])}>
            Discard
          </Button>
        </div>
      ) : null}
      {saved.length > 0 ? (
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await save({ waterBodyId: body._id as Id<'waterBodies'>, points: [] });
              onResult({ tone: 'ok', text: 'Cleared — back to the centroid default.' });
            } catch (err) {
              onResult({ tone: 'error', text: errorText(err) });
            }
          }}
        >
          Clear saved points
        </Button>
      ) : null}
    </ToolCard>
  );
}

/**
 * What a delisted body shows instead of the editor (D48) — and the way back.
 *
 * `waterBodies.get` answers `{ available: false }` for anything unlisted, without the row, so this
 * has only the id from the route. That is enough: `restore` takes an id, and everything else on this
 * screen would be editing a lake that draws nowhere.
 */
function RestoreGate({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const restore = useMutation(api.waterBodies.restore);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-start gap-3">
      <AdminEmpty>
        This body isn’t on the map (removed, rejected or merged). Restore it before editing — a
        sub-area drawn on an unlisted lake would have nowhere to render.
      </AdminEmpty>
      {error ? <p className="text-danger text-sm">{error}</p> : null}
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          setError(null);
          try {
            await restore({ waterBodyId });
          } catch (err) {
            // A `reject`ed or `merge`d body lands here too, and the server's refusal says which —
            // "not removed" is the honest answer for a body that is unlisted for another reason.
            setError(errorText(err));
          }
        }}
      >
        Restore to the map
      </Button>
      <Link
        to="/admin/water"
        className="text-foreground-muted text-sm underline underline-offset-2"
      >
        ← Back to the water queues
      </Link>
    </div>
  );
}

/** Why an admin delisted a body (D48). Mirrors `REMOVAL_REASONS`; the server validates the value. */
const REMOVAL_REASON_LABELS: Record<string, string> = {
  landowner_request: 'Landowner request',
  unskateable: 'Not skateable',
  junk: 'Junk data',
  duplicate: 'Duplicate',
  other: 'Other',
};

/**
 * Take a body off the map, or put it back (D48) — **admin-only, reversible, never a hard delete.**
 *
 * `remove`/`restore` shipped in Phase 2 and had no caller in either app until now, which meant a
 * landowner takedown — the case D48 was built *for* — could only be performed from the Convex
 * dashboard. Same shape of gap as `putIns.setOfficial`: a fully implemented, authz'd, audited
 * mutation with nothing to press.
 *
 * Removing drops the body's cell rows so it leaves the map at zero read cost, and takes its named
 * bays with it — a delisted Champlain still drawing "Malletts Bay" would be worse than either
 * outcome. Restoring brings back the bays that weren't delisted in their own right.
 *
 * Last in the tool column, above the history: it is the one action here that removes rather than
 * refines, and nothing that refines should sit below it.
 */
function RemovalTool({ body, onResult }: { body: Doc<'waterBodies'>; onResult: SetBanner }) {
  const remove = useMutation(api.waterBodies.remove);
  const restore = useMutation(api.waterBodies.restore);
  const [reason, setReason] = useState('landowner_request');
  const removed = body.removedAt !== undefined;

  return (
    <ToolCard title="Listing">
      {removed ? (
        <>
          <p className="text-foreground-muted text-sm">
            Delisted{body.removalReason ? ` — ${REMOVAL_REASON_LABELS[body.removalReason]}` : ''}.
            It draws nowhere, and its bays are off the map with it.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={async () => {
              try {
                await restore({ waterBodyId: body._id as Id<'waterBodies'> });
                onResult({ tone: 'ok', text: 'Restored to the map.' });
              } catch (err) {
                onResult({ tone: 'error', text: errorText(err) });
              }
            }}
          >
            Restore to the map
          </Button>
        </>
      ) : (
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
            title="Delist this water body"
            description="It stops drawing, its cell rows are dropped, and its named bays go with it. Reversible from this card — nothing is deleted."
            confirmLabel="Delist"
            confirmVariant="secondary"
            requireReason={false}
            reasonPlaceholder="Optional note for the audit log"
            onConfirm={async () => {
              try {
                await remove({
                  waterBodyId: body._id as Id<'waterBodies'>,
                  reason: reason as 'landowner_request',
                });
                onResult({ tone: 'ok', text: 'Taken off the map.' });
              } catch (err) {
                onResult({ tone: 'error', text: errorText(err) });
              }
            }}
          />
          <p className="text-foreground-muted text-xs">
            Admin only, and reversible — the row, its reports and its hazards all survive. A
            re-import preserves the delisting rather than quietly putting the lake back.
          </p>
        </>
      )}
    </ToolCard>
  );
}

/**
 * Put-ins (Phase 4, decision #7) — the existing mutations, on the canvas that shows where they are.
 *
 * **This card used to be three counts and a link reading "Place and hide pins on the public map →".**
 * There was no such control on the public map; `putIns.setOfficial` and `putIns.hide` had shipped in
 * Phase 4 with a comment deferring the operator UI to Phase 7 and had zero callers in either app
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
 */
function PutInTool({
  waterBodyId,
  putIns,
  armed,
  onArm,
  point,
  onClearPoint,
  onResult,
}: {
  waterBodyId: Id<'waterBodies'>;
  putIns: readonly { coord: LatLng; source: string; name?: string }[];
  armed: boolean;
  onArm: (on: boolean) => void;
  point: LatLng | null;
  onClearPoint: () => void;
  onResult: SetBanner;
}) {
  const setOfficial = useMutation(api.putIns.setOfficial);
  const hide = useMutation(api.putIns.hide);
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
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
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
                  try {
                    await hide({ waterBodyId, coord: p.coord, reason });
                    onResult({ tone: 'ok', text: 'Put-in hidden.' });
                  } catch (err) {
                    onResult({ tone: 'error', text: errorText(err) });
                  }
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

/**
 * Parking and the approach (N6d / D72 amendment, D144) — **rung 1 of the access ladder.**
 *
 * This is where a human's assertion outranks the OSM pass. Two rules make it different from every
 * other tool on this page:
 *
 * **No distance limit.** `PARKING_INFER_RADIUS_M` bounds what the *ETL* will guess; an operator may
 * associate a lot with this lake from any distance at all, because a trailhead a mile from the ice is
 * not an edge case to tolerate — it is the case the phase exists for. The form says so out loud,
 * because the absence of a validation error is otherwise indistinguishable from a bug.
 *
 * **Above a mile the approach kind must be asserted, not derived** (D144). The server refuses the
 * write otherwise, and it refuses rather than defaulting: stamping `hike_in` silently would be the
 * system making the assertion on the operator's behalf, when the whole point is that a far-flung
 * association is the one input here that costs its author nothing and a stranger a night.
 */
function AccessTool({
  waterBodyId,
  armed,
  onArm,
  point,
  onClearPoint,
  onResult,
}: {
  waterBodyId: Id<'waterBodies'>;
  armed: boolean;
  onArm: (on: boolean) => void;
  point: LatLng | null;
  onClearPoint: () => void;
  onResult: SetBanner;
}) {
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId });
  const setParking = useMutation(api.accessPoints.setOfficialParking);
  const setPutInAccess = useMutation(api.accessPoints.setPutInAccess);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedPutIn, setSelectedPutIn] = useState('');
  const [selectedLot, setSelectedLot] = useState('');
  const [kind, setKind] = useState('');

  const lots = access?.parking ?? [];
  const storedPutIns = access?.putIns ?? [];

  /**
   * **This used to be two text boxes taking a decimal latitude and longitude** (N6f), with the lake
   * on a locked canvas three feet to the left. Typed coordinates are how a lot ends up in the wrong
   * hemisphere from a dropped minus sign — and there is no validation that could catch it, because
   * every plausible typo is still a valid coordinate somewhere on earth. A click cannot be in the
   * wrong hemisphere: the camera is locked to this body.
   */
  async function addLot() {
    if (!point) return;
    setBusy(true);
    try {
      await setParking({
        coord: point,
        ...(name.trim() ? { name: name.trim() } : {}),
        amenities: [],
        waterBodyIds: [waterBodyId],
      });
      onClearPoint();
      setName('');
      onResult({ tone: 'ok', text: 'Parking area saved at the operator rung.' });
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function linkPutIn() {
    if (!selectedPutIn) return;
    setBusy(true);
    try {
      await setPutInAccess({
        putInId: selectedPutIn as Id<'putIns'>,
        ...(selectedLot ? { parkingAreaId: selectedLot as Id<'parkingAreas'> } : {}),
        ...(selectedLot ? {} : { clearParking: true }),
        ...(kind ? { approachKindOverride: kind as 'hike_in' } : {}),
      });
      onResult({ tone: 'ok', text: 'Access updated.' });
    } catch (err) {
      // The D144 refusal lands here verbatim — the server writes the operator-facing sentence.
      onResult({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolCard title="Parking & approach">
      {lots.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {lots.map((lot) => (
            <li key={lot.id} className="text-foreground-muted">
              {lot.name ?? 'Unnamed lot'} — {lot.source}
              {lot.amenities.length > 0 ? ` · ${lot.amenities.join(', ')}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-foreground-muted text-sm">No parking on record for this lake.</p>
      )}

      <div className="flex flex-col gap-2 border-border border-t pt-2">
        <Button
          variant={armed ? 'default' : 'outline'}
          size="sm"
          className="self-start"
          onClick={() => onArm(!armed)}
        >
          {armed ? 'Click the map…' : point ? 'Pick a different spot' : 'Place a parking area'}
        </Button>
        {point ? (
          <>
            <p className="text-foreground-muted text-xs">
              {point.lat.toFixed(5)}, {point.lng.toFixed(5)} — drawn hollow until you save.
            </p>
            <Input
              placeholder="Name (optional) — e.g. Reservoir Road lot"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void addLot()}>
                {busy ? 'Saving…' : 'Save at the operator rung'}
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
          The camera is locked to this lake, so a click can only land near it — but there is
          deliberately <strong>no distance limit</strong> on the association below. The ~250 m
          radius caps what the OSM pass will guess, never what you can assert; a trailhead a mile
          from the ice is the case this exists for.
        </p>
      </div>

      {storedPutIns.length > 0 ? (
        <div className="space-y-2 border-border border-t pt-2">
          <select
            className="w-full rounded border p-1 text-sm"
            value={selectedPutIn}
            onChange={(e) => setSelectedPutIn(e.target.value)}
            aria-label="Put-in"
          >
            <option value="">Choose a put-in…</option>
            {storedPutIns.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? 'Unnamed launch'} ({p.source})
              </option>
            ))}
          </select>
          <select
            className="w-full rounded border p-1 text-sm"
            value={selectedLot}
            onChange={(e) => setSelectedLot(e.target.value)}
            aria-label="Parking area"
          >
            <option value="">No parking (clears the approach)</option>
            {lots.map((lot) => (
              <option key={lot.id} value={lot.id}>
                {lot.name ?? 'Unnamed lot'}
              </option>
            ))}
          </select>
          <select
            className="w-full rounded border p-1 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Approach kind"
          >
            <option value="">Derive the approach kind from the distance</option>
            <option value="drive_up">Drive-up</option>
            <option value="short_walk">Short walk</option>
            <option value="hike_in">Hike-in</option>
          </select>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void linkPutIn()}>
            Save access
          </Button>
          <p className="text-foreground-muted text-xs">
            Beyond a mile the server <strong>requires</strong> Hike-in to be chosen explicitly
            rather than derived, so a long approach can't be entered silently.
          </p>
        </div>
      ) : null}
    </ToolCard>
  );
}

/** Hazards and crossings on this body — listed here, moderated through their own detail. */

/**
 * Author a persistent body feature by hand (D79).
 *
 * **A bigger gap than it sounds.** `bodyFeatures.create` has existed since Phase 9 with no UI
 * anywhere, so the only way to hand-make a permanent feature was the Convex dashboard or the CLI —
 * which left four of the nine types (`constriction`, `bridge_narrows`, `delta`, `shallow_early_thaw`)
 * unreachable in the product entirely: no hazard promotes into them, and no form created them.
 *
 * It is also the answer to *"what covers the first three winters"*. The recurrence engine needs
 * seasons of evidence before it can propose anything; an operator who **knows** a lake has a spring at
 * the outlet shouldn't have to wait for the corpus to prove it. The engine is for the lakes nobody on
 * the team skates.
 *
 * Three primitives, matching the hazard authoring they sit beside (D51): a point with a radius (a
 * click on the map — the commonest case by far, since a spring or a gas hole *is* a spot), a drawn
 * polygon (the shared terra-draw control, still lazy-loaded), and pasted GeoJSON, which is how a line
 * traced elsewhere gets in and the break-glass path if the draw engine fails to load.
 */
function BodyFeatureTool({
  waterBodyId,
  features,
  draft,
  setDraft,
  point,
  setPoint,
  arming,
  setArming,
  mapRef,
  onResult,
}: {
  waterBodyId: Id<'waterBodies'>;
  features: readonly { _id: string; type: string; note?: string }[];
  draft: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  setDraft: (polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null) => void;
  point: LatLng | null;
  setPoint: (coord: LatLng | null) => void;
  arming: boolean;
  setArming: (armed: boolean) => void;
  mapRef: { current: maplibregl.Map | null };
  onResult: SetBanner;
}) {
  const create = useMutation(api.bodyFeatures.create);
  const demote = useMutation(api.bodyFeatures.demote);
  const [type, setType] = useState<BodyFeatureType>('spring_current');
  const [radius, setRadius] = useState(30);
  const [note, setNote] = useState('');
  const [paste, setPaste] = useState('');
  const [drawing, setDrawing] = useState(false);
  const controlRef = useRef<PolygonDrawControl | null>(null);

  useEffect(() => {
    return () => {
      controlRef.current?.destroy();
      controlRef.current = null;
    };
  }, []);

  const armDraw = async () => {
    const map = mapRef.current;
    if (!map) return;
    setArming(false);
    setPoint(null);
    try {
      if (!controlRef.current) {
        controlRef.current = await createPolygonDraw(map, {
          onFinish: (polygon) => {
            setDraft(polygon);
            setDrawing(false);
          },
        });
      }
      controlRef.current.startDrawing();
      setDrawing(true);
    } catch {
      onResult({
        tone: 'error',
        text: "Couldn't load the draw tool. Paste the outline as GeoJSON instead — it does the same thing.",
      });
    }
  };

  const save = async () => {
    // A point with a radius wins when one is placed: it is the primitive that needed no engine, and
    // the one the commonest features (a spring, a gas hole, a reef) actually are.
    const shape = point
      ? {
          geometryKind: 'point_radius' as const,
          geometry: { type: 'Point' as const, coordinates: [point.lng, point.lat] },
          radiusMeters: radius,
        }
      : draft
        ? { geometryKind: 'polygon' as const, geometry: draft }
        : null;
    if (!shape) {
      onResult({ tone: 'error', text: 'Place a point or draw an outline first.' });
      return;
    }
    try {
      await create({
        waterBodyId,
        type,
        ...shape,
        ...(note.trim() ? { note: note.trim() } : {}),
        reason: `Authored by hand: ${BODY_FEATURE_TYPE_LABELS[type]}.`,
      });
      onResult({ tone: 'ok', text: `Added ${BODY_FEATURE_TYPE_LABELS[type].toLowerCase()}.` });
      setDraft(null);
      setPoint(null);
      setNote('');
      setArming(false);
      controlRef.current?.clear();
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
    }
  };

  return (
    <ToolCard title="Known features">
      <p className="text-foreground-muted text-sm">
        Permanent properties of this lake — always shown, never decayed, no confirm loop. Add one
        when you know it, rather than waiting for enough winters of reports to prove it.
      </p>

      {features.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {features.map((f) => (
            <li key={f._id} className="flex items-center justify-between gap-2">
              <span className="text-foreground">
                {BODY_FEATURE_TYPE_LABELS[f.type as BodyFeatureType] ?? f.type}
                {f.note ? <span className="text-foreground-muted"> — {f.note}</span> : null}
              </span>
              <ReasonDialog
                trigger={
                  <Button variant="outline" size="sm">
                    Remove
                  </Button>
                }
                title="Remove this feature"
                description="It stops rendering. Nothing is deleted, and it can be added again."
                confirmLabel="Remove"
                onConfirm={(reason) =>
                  demote({ bodyFeatureId: f._id as Id<'bodyFeatures'>, reason }).then(
                    () => undefined,
                  )
                }
              />
            </li>
          ))}
        </ul>
      ) : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-foreground-muted">What is it?</span>
        <select
          className="rounded-md border border-border bg-surface px-2 py-1 text-foreground text-sm"
          value={type}
          onChange={(e) => setType(e.target.value as BodyFeatureType)}
        >
          {BODY_FEATURE_TYPES.map((t) => (
            <option key={t} value={t}>
              {BODY_FEATURE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          variant={arming ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            setArming(!arming);
            setDraft(null);
          }}
        >
          {arming ? 'Click the map…' : 'Place a point'}
        </Button>
        <Button variant={drawing ? 'default' : 'outline'} size="sm" onClick={armDraw}>
          {drawing ? 'Drawing…' : 'Draw an outline'}
        </Button>
      </div>

      {point ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-foreground-muted">Radius</span>
          <input
            type="number"
            min={1}
            max={5000}
            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-foreground text-sm"
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
          />
          <span className="text-foreground-muted">m</span>
        </label>
      ) : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-foreground-muted">Note (optional)</span>
        <input
          className="rounded-md border border-border bg-surface px-2 py-1 text-foreground text-sm"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Outlet current — never freezes here"
        />
      </label>

      <details>
        <summary className="cursor-pointer text-foreground-muted text-xs">
          Paste GeoJSON instead
        </summary>
        <textarea
          className="mt-1 h-20 w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-foreground text-xs"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder='{"type":"Polygon","coordinates":[[…]]}'
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const parsed = parsePastedPolygon(paste);
            if (!parsed.ok) {
              onResult({ tone: 'error', text: parsed.error });
              return;
            }
            setPoint(null);
            setArming(false);
            setDraft(parsed.polygon);
          }}
        >
          Use it
        </Button>
      </details>

      <Button size="sm" disabled={!point && !draft} onClick={save}>
        Add feature
      </Button>
    </ToolCard>
  );
}

function HazardTool({ hazards }: { hazards: readonly { _id: string; type: string }[] }) {
  return (
    <ToolCard title="Hazards & crossings">
      {hazards.length === 0 ? (
        <p className="text-foreground-muted text-sm">Nothing marked on this body.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {hazards.map((h) => (
            <li key={h._id}>
              <Link
                to="/hazard/$id"
                params={{ id: h._id }}
                className="text-foreground underline underline-offset-2"
              >
                {h.type.replace(/_/g, ' ')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ToolCard>
  );
}

/**
 * Aggregate tracks — **view-only** (Decision 8).
 *
 * The lever on a bad track is its report's `setModerationStatus`, which already drops the track,
 * because D58's whole argument is that there is no separate `sharedToAggregate` flag: a second flag
 * would let the two disagree and would ask people to consent twice to one thing. An explicit
 * per-activity exclusion is deferred with a written trigger — a real track that is bad on the map
 * but fine as a report.
 */
function TrackTool({ tracks }: { tracks: readonly unknown[] }) {
  return (
    <ToolCard title="Aggregate tracks">
      <p className="text-foreground-muted text-sm">
        {tracks.length} contributing track{tracks.length === 1 ? '' : 's'} (view-only).
      </p>
      <p className="text-foreground-muted text-xs">
        A track is dropped by hiding the report it belongs to — there’s deliberately no second
        consent flag for the aggregate layer (D58).
      </p>
    </ToolCard>
  );
}

/**
 * **The pre-first-ice pass** (N5a/D63) — last season's hazards, ranked by how likely they are to be
 * back, each one promotion away from becoming a permanent body feature (D53).
 *
 * Framed as a safety task because it is one. Seasonal scoping hides last winter's hazards, so the
 * first skater in November sees a clean map where there was a ridge; this list is what covers that,
 * and an operator who reads it as housekeeping will skip it in a busy week. The copy says so.
 *
 * What it must never say is that a hazard *will* be there (D3). The ranking orders candidates for a
 * human decision — decay tier, corroboration, type — and the promotion it offers is the operator's
 * judgement, recorded with their reason like every other moderation action.
 */

/**
 * **Recurring** — the cross-season half of the pre-first-ice pass (N5c / §7.1).
 *
 * The section below this one ranks *last season's* hazards, which is all the single-season list can
 * see and all it will be able to see on most lakes for years. This one ranks **patterns**: what came
 * back, in how many of the last four winters, when in the winter, and how many different people saw
 * it. Where a pattern exists it outranks a single sighting, because it is the only signal here that is
 * about recurrence rather than about a row.
 *
 * **Nothing on this card is a prediction.** It is what was reported and how often — the same line
 * `hazardPromotion` already holds, one window out. The card states its own provenance with a recompute
 * button beside it, because a stale answer that looks live is the failure mode of every precomputed
 * surface.
 */
function RecurrenceTool({
  waterBodyId,
  onResult,
}: {
  waterBodyId: Id<'waterBodies'>;
  onResult: SetBanner;
}) {
  const clusters = useQuery(api.recurrence.listForBodyAdmin, { waterBodyId });
  const promote = useMutation(api.recurrence.promoteFromRecurrence);
  const suppress = useMutation(api.recurrence.suppress);
  const unsuppress = useMutation(api.recurrence.unsuppress);
  const recompute = useMutation(api.recurrence.recomputeForBody);
  const [busy, setBusy] = useState(false);

  const onRecompute = async () => {
    setBusy(true);
    try {
      await recompute({ waterBodyId });
      onResult({ tone: 'ok', text: 'Recomputed from this lake’s hazards.' });
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolCard title="Before first ice — what came back">
      <p className="text-foreground-muted text-sm">
        Patterns across winters, computed at the season rollover.{' '}
        <strong className="text-foreground">Nothing here is a prediction</strong> — it is what was
        reported, and how often.
      </p>
      {clusters === undefined ? (
        <p className="text-foreground-muted text-sm">Loading…</p>
      ) : clusters.length === 0 ? (
        <p className="text-foreground-muted text-sm">
          No cross-season patterns on this lake yet. A pattern needs the same spot reported in more
          than one winter, so a lake in its first season has none by construction.
        </p>
      ) : (
        <ul className="flex flex-col gap-3 text-sm">
          {clusters.map((cluster) => (
            <li key={cluster._id} className="flex flex-col gap-1">
              <span className="text-foreground">
                {/* Both numbers, always — the denominator is what stops a reader inflating it, and an
                    operator surface is not exempt from that. */}
                Seen in <strong>{cluster.seasonsObserved.length}</strong> of the last{' '}
                {cluster.windowSeasons} winters
                {cluster.subAreaName ? ` near ${cluster.subAreaName}` : ''}
              </span>
              <span className="text-foreground-muted text-xs">
                {cluster.seasonsObserved.map((s) => formatSeason(s)).join(', ')}
                {' · '}
                {timingWindowLabel(
                  cluster.firstReportedDayOfSeasonP25,
                  cluster.firstReportedDayOfSeasonP75,
                ) ?? 'timing unclear'}
                {' · '}
                {cluster.distinctAuthorCount} reporter
                {cluster.distinctAuthorCount === 1 ? '' : 's'}
                {' · '}
                {cluster.memberHazardIds.length} pin
                {cluster.memberHazardIds.length === 1 ? '' : 's'}
              </span>
              {/* One reporter across several winters is not a red flag, and is deliberately not a gate
                  (answered at scoping): a pond nobody else visits is exactly where the feature matters
                  most. It is shown so a false pattern from a single account is visible. */}
              {cluster.distinctAuthorCount === 1 ? (
                <span className="text-foreground-muted text-xs">
                  One reporter — worth a second look before promoting.
                </span>
              ) : null}
              {cluster.staleSince !== undefined ? (
                <span className="text-foreground-muted text-xs">
                  No longer matches anything visible — kept because a decision was made about it.
                </span>
              ) : null}
              {/* Never let a capped read read as a complete one: this lake holds more sightings in
                  the window than one recompute reads, so the denominator beside it may undercount. */}
              {cluster.computedFromPartialHistory ? (
                <span className="text-foreground-muted text-xs">
                  Computed from this lake’s most recent sightings only — it holds more in the window
                  than one pass reads, so the winter count may be low.
                </span>
              ) : null}
              <span className="flex flex-wrap gap-2">
                {cluster.promotedToFeatureId ? (
                  <span className="text-foreground-muted text-xs">
                    Already a permanent feature. Sightings keep counting.
                  </span>
                ) : cluster.suppressedAt !== undefined ? (
                  <>
                    <span className="text-foreground-muted text-xs">
                      Suppressed — {cluster.suppressReason}
                    </span>
                    {/* §7.3 calls suppression reversible, and a reversal needs somewhere to be
                        pressed. Without this the mutation exists and the product has no way to reach
                        it, which is a delete with better paperwork. */}
                    <ReasonDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          Unsuppress
                        </Button>
                      }
                      title="Unsuppress this pattern"
                      description="It returns to the suggestion queue and regains the public bar. The original suppression and its reason stay in the audit log."
                      confirmLabel="Unsuppress"
                      onConfirm={(reason) =>
                        unsuppress({ recurrenceId: cluster._id, reason }).then(() => undefined)
                      }
                    />
                  </>
                ) : (
                  <>
                    {cluster.suggestedFeatureType ? (
                      <ReasonDialog
                        trigger={
                          <Button size="sm" variant="outline">
                            Promote to {BODY_FEATURE_TYPE_LABELS[cluster.suggestedFeatureType]}
                          </Button>
                        }
                        title="Promote this pattern"
                        description="It becomes a permanent feature of the lake, which no seasonal reset touches. Every sighting behind it stays on the map and keeps counting."
                        confirmLabel="Promote"
                        onConfirm={(reason) =>
                          promote({
                            recurrenceId: cluster._id,
                            type: cluster.suggestedFeatureType as BodyFeatureType,
                            reason,
                          }).then(() => undefined)
                        }
                      />
                    ) : (
                      <span className="text-foreground-muted text-xs">
                        Nothing to promote it to — the depth on this lake disagrees, or the family
                        has no permanent equivalent.
                      </span>
                    )}
                    <ReasonDialog
                      trigger={
                        <Button size="sm" variant="outline">
                          Suppress
                        </Button>
                      }
                      title="Suppress this pattern"
                      description="It stops being suggested and stops being publicly advisable, across every recompute. Reversible, and nothing is deleted."
                      confirmLabel="Suppress"
                      onConfirm={(reason) =>
                        suppress({ recurrenceId: cluster._id, reason }).then(() => undefined)
                      }
                    />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-foreground-muted text-xs">
          {clusters && clusters.length > 0 && clusters[0]
            ? `Computed ${new Date(clusters[0].computedAt).toLocaleDateString()} for ${formatSeason(clusters[0].computedForSeason)}.`
            : 'Not computed yet.'}
        </span>
        <Button size="sm" variant="outline" disabled={busy} onClick={onRecompute}>
          {busy ? 'Recomputing…' : 'Recompute now'}
        </Button>
      </span>
    </ToolCard>
  );
}

function PromotionTool({
  waterBodyId,
  onResult,
}: {
  waterBodyId: Id<'waterBodies'>;
  onResult: (banner: { tone: 'ok' | 'error'; text: string }) => void;
}) {
  const candidates = useQuery(api.hazards.listPromotionCandidates, { waterBodyId });
  const promote = useMutation(api.bodyFeatures.promote);
  const [busyId, setBusyId] = useState<string | null>(null);

  const lastSeason = seasonOf(Date.now()) - 1;

  const onPromote = async (candidate: {
    hazardId: string;
    type: string;
    promotesTo: PromotionTarget | null;
  }) => {
    if (!candidate.promotesTo) return;
    setBusyId(candidate.hazardId);
    try {
      await promote({
        hazardId: candidate.hazardId as Id<'hazards'>,
        // No cast: `PromotionTarget` is a subset of the mutation's own union, so the two stay honest
        // about each other and a drift between the promotion table and the backend enum won't compile.
        type: candidate.promotesTo,
        reason: `Recurring ${candidate.type.replace(/_/g, ' ')} — promoted in the pre-season pass.`,
      });
      onResult({ tone: 'ok', text: 'Promoted to a permanent body feature.' });
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <ToolCard title="Before first ice — last season, single sighting">
      <p className="text-foreground-muted text-sm">
        Last season’s hazards are hidden from the map now. Anything that forms here every winter
        should be promoted to a permanent feature, which no seasonal reset touches —{' '}
        <strong className="text-foreground">this is a safety pass, not tidying up</strong>: a skater
        in November sees a clean map otherwise. These have somewhere to be promoted <em>to</em> but
        no history behind them yet — the card above is where a pattern would show.
      </p>
      {candidates === undefined ? (
        <p className="text-foreground-muted text-sm">Loading…</p>
      ) : candidates.length === 0 ? (
        <p className="text-foreground-muted text-sm">
          Nothing from {formatSeason(lastSeason)} that could be a permanent feature. Volatile
          hazards — open water, thin ice, slush — are deliberately not listed: they happen where the
          weather puts them, and a permanent marker would be a warning nobody can clear.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {candidates.map((candidate) => (
            <li
              key={candidate.hazardId}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span className="flex flex-col">
                <Link
                  to="/hazard/$id"
                  params={{ id: candidate.hazardId }}
                  className="text-foreground underline underline-offset-2"
                >
                  {candidate.type.replace(/_/g, ' ')}
                </Link>
                <span className="text-foreground-muted text-xs">
                  {candidate.confirmCount} confirmation
                  {candidate.confirmCount === 1 ? '' : 's'}
                  {candidate.archived ? ' · community marked it healed' : ''}
                  {' · '}
                  becomes {candidate.promotesTo?.replace(/_/g, ' ')}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === candidate.hazardId}
                onClick={() => onPromote(candidate)}
              >
                {busyId === candidate.hazardId ? 'Promoting…' : 'Promote'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-foreground-muted text-xs">
        Ranked by how the type behaves and how many people confirmed it — a queue for your
        judgement, not a prediction that any of them will be back.
      </p>
    </ToolCard>
  );
}

/**
 * Operator-entered reference links (N6c Workstream B7) — the phase's only stored link.
 *
 * Everything else in the lake drawer's link list is derived from the row at render time (P2/D71) and
 * has no editor because there is nothing to edit. A lake association's URL is genuinely
 * non-derivable, so it gets one, and it is expected to be used on **tens** of bodies rather than
 * thousands. That is the exception proving the rule, not a coverage gap.
 */
/**
 * The Copernicus link's per-row override (N6c Workstream D, D70/D75).
 *
 * **Shows the derivation before it shows the lever**, which is the same argument `ProminenceTool`
 * makes: `auto`/`on`/`off` is an abstract tri-state, while "10 m pixels over 4 ha — about 400 pixels
 * of water" is the thing an operator is actually judging. Without the area beside it, the only way to
 * decide is to guess what the threshold was.
 *
 * The three buttons are a segmented control rather than a select, because there are exactly three
 * values and the current one should be readable without opening anything — and `auto` is deliberately
 * first and labelled with its consequence, since it is both the default and the undo.
 */
function SatelliteTool({ body, onResult }: { body: Doc<'waterBodies'>; onResult: SetBanner }) {
  const setMode = useMutation(api.waterBodies.setSatelliteImagery);
  const [busy, setBusy] = useState(false);
  const mode: SatelliteImageryMode = body.satelliteImagery ?? 'auto';

  const areaSqM = body.surfaceAreaSqM;
  // What `auto` would decide on its own — the number the override is agreeing or disagreeing with.
  const autoWould = satelliteImageryAvailable({ ...body, satelliteImagery: 'auto' });
  const offered = satelliteImageryAvailable(body);
  const hectares = areaSqM === undefined ? null : areaSqM / 10_000;
  // 10 m ground sample distance, so a pixel is 100 m² — the figure that makes the threshold concrete.
  const pixels = areaSqM === undefined ? null : Math.round(areaSqM / 100);

  async function save(next: SatelliteImageryMode) {
    setBusy(true);
    try {
      await setMode({ waterBodyId: body._id, mode: next });
      onResult({ tone: 'ok', text: `Satellite link set to ${next}.` });
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  const choices: { value: SatelliteImageryMode; label: string }[] = [
    { value: 'auto', label: `Auto (${autoWould ? 'offer' : 'withhold'})` },
    { value: 'on', label: 'Always offer' },
    { value: 'off', label: 'Never offer' },
  ];

  return (
    <ToolCard title="Satellite link">
      <div className="flex flex-wrap gap-2">
        {choices.map((choice) => (
          <Button
            key={choice.value}
            size="sm"
            variant={mode === choice.value ? 'secondary' : 'outline'}
            disabled={busy || mode === choice.value}
            onClick={() => save(choice.value)}
          >
            {choice.label}
          </Button>
        ))}
      </div>
      <p className="text-foreground-muted text-sm">
        {hectares === null ? (
          <>
            No stored area, so auto offers the link — a missing field is the wrong thing to withhold
            on.
          </>
        ) : (
          <>
            {hectares.toFixed(1)} ha ≈{' '}
            <span className="text-foreground">{pixels?.toLocaleString()}</span> Sentinel pixels; the
            floor is {(SATELLITE_MIN_AREA_SQM / 10_000).toFixed(0)} ha.
          </>
        )}{' '}
        Currently{' '}
        <span className="font-medium text-foreground">{offered ? 'offered' : 'withheld'}</span>
        {mode !== 'auto' && offered !== autoWould ? ' — an override, against the area' : null}.
      </p>
      <p className="text-foreground-muted text-xs">
        Copernicus only (10 m). The 0.3 m aerial reveal on the map is a different tier and is not
        governed by this.
      </p>
    </ToolCard>
  );
}

function ReferenceLinkTool({ body, onResult }: { body: Doc<'waterBodies'>; onResult: SetBanner }) {
  const setLinks = useMutation(api.waterBodies.setReferenceLinks);
  const [links, setLinks_] = useState<{ label: string; url: string }[]>(body.referenceLinks ?? []);
  const [busy, setBusy] = useState(false);

  // The same validator the mutation runs, so an operator sees the error without a round trip. The
  // server check is the guarantee; this one is the courtesy.
  const firstError = links.map((link) => referenceLinkError(link)).find((e) => e !== null) ?? null;

  async function save() {
    setBusy(true);
    try {
      await setLinks({ waterBodyId: body._id, links });
      onResult({ tone: 'ok', text: 'Reference links saved.' });
    } catch (err) {
      onResult({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ToolCard title="Reference links">
      <div className="flex flex-col gap-2">
        {links.map((link, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the row IS its index; there is no stable id.
          <div key={index} className="flex flex-col gap-1">
            <input
              className="rounded border border-border bg-surface px-2 py-1 text-sm"
              placeholder="Label — e.g. Westmore Association"
              value={link.label}
              onChange={(e) =>
                setLinks_(links.map((l, i) => (i === index ? { ...l, label: e.target.value } : l)))
              }
            />
            <div className="flex gap-1">
              <input
                className="flex-1 rounded border border-border bg-surface px-2 py-1 text-sm"
                placeholder="https://…"
                value={link.url}
                onChange={(e) =>
                  setLinks_(links.map((l, i) => (i === index ? { ...l, url: e.target.value } : l)))
                }
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => setLinks_(links.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
        {firstError ? <p className="text-danger text-xs">{firstError}</p> : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLinks_([...links, { label: '', url: '' }])}
          >
            Add a link
          </Button>
          <Button size="sm" disabled={busy || firstError !== null} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
        <p className="text-foreground-muted text-xs">
          For things no algorithm can derive — a lake association, a town page. Windy and the
          regional community link are generated automatically and need no entry here.
        </p>
      </div>
    </ToolCard>
  );
}
