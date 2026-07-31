import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
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
  seasonOf,
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
import { ReasonDialog } from '../components/admin/ReasonDialog';
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
  const hazards = useQuery(api.hazards.listForBody, { waterBodyId });
  const features = useQuery(api.bodyFeatures.listForBody, { waterBodyId });
  const tracks = useQuery(api.gpsActivities.listTracksForBody, { waterBodyId });

  const [draft, setDraft] = useState<GeoJSON.Polygon | GeoJSON.MultiPolygon | null>(null);
  const [suggested, setSuggested] = useState<LatLng[]>([]);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
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
  const [placingFeature, setPlacingFeature] = useState(false);

  if (result === undefined) return <AdminEmpty>Loading…</AdminEmpty>;
  if (result === null || !body) {
    return <AdminEmpty>No such water body. The link may be broken.</AdminEmpty>;
  }
  if (!result.available) {
    return (
      <AdminEmpty>
        This body isn’t on the map (removed, rejected or merged). Restore it before editing — a
        sub-area drawn on an unlisted lake would have nowhere to render.
      </AdminEmpty>
    );
  }

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
        <div className="h-[70vh] min-h-96 overflow-hidden rounded-lg border border-border">
          <LakeEditorMap
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
              samplePoints: body.weatherSamplePoints ?? [],
              // One draft slot on the map, shared by the two tools that produce a shape. They can't
              // both be armed — arming either clears the other — so there is never a shape on screen
              // whose owner is ambiguous.
              draftPolygon: draft ?? featureDraft,
              suggestedPoints: featurePoint ? [...suggested, featurePoint] : suggested,
            }}
            onMapClick={(coord) => {
              if (!placingFeature) return;
              setFeaturePoint(coord);
              setPlacingFeature(false);
            }}
            onReady={(map) => {
              drawTargetRef.current = map;
            }}
          />
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto">
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
          <PutInTool waterBodyId={waterBodyId} putIns={putIns ?? []} />
          <BodyFeatureTool
            waterBodyId={waterBodyId}
            features={features ?? []}
            draft={featureDraft}
            setDraft={setFeatureDraft}
            point={featurePoint}
            setPoint={setFeaturePoint}
            arming={placingFeature}
            setArming={setPlacingFeature}
            mapRef={drawTargetRef}
            onResult={setBanner}
          />
          <HazardTool hazards={hazards ?? []} />
          <RecurrenceTool waterBodyId={waterBodyId} onResult={setBanner} />
          <PromotionTool waterBodyId={waterBodyId} onResult={setBanner} />
          <TrackTool tracks={Array.isArray(tracks) ? [] : (tracks?.tracks ?? [])} />
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

/** Put-ins (Phase 4, decision #7) — the existing mutations, on the canvas that shows where they are. */
function PutInTool({
  waterBodyId,
  putIns,
}: {
  waterBodyId: Id<'waterBodies'>;
  putIns: readonly { coord: LatLng; source: string }[];
}) {
  const official = putIns.filter((p) => p.source === 'official').length;
  const derived = putIns.filter((p) => p.source === 'derived').length;
  return (
    <ToolCard title="Put-ins">
      <p className="text-foreground-muted text-sm">
        {official} official · {derived} derived from reports.
      </p>
      <Link
        to="/water/$id"
        params={{ id: waterBodyId }}
        className="text-foreground-muted text-sm underline underline-offset-2"
      >
        Place and hide pins on the public map →
      </Link>
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
