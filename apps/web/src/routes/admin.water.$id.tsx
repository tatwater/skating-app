import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
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
} from '@skating/core';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import type maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { LakeEditorMap } from '../components/admin/LakeEditorMap';
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
  const tracks = useQuery(api.gpsActivities.listTracksForBody, { waterBodyId });

  const [draft, setDraft] = useState<GeoJSON.Polygon | GeoJSON.MultiPolygon | null>(null);
  const [suggested, setSuggested] = useState<LatLng[]>([]);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // The live map handle, so the lazily-created draw control can attach to the canvas. A ref on the
  // component rather than a module-level object: a module singleton outlives the route, holding a
  // removed map that the next visit's draw control would happily attach to.
  const drawTargetRef = useRef<maplibregl.Map | null>(null);

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
              suggestedPoints: suggested,
              draftPolygon: draft,
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
          <HazardTool hazards={hazards ?? []} />
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

/**
 * Lake depth (N6a / D68) — rung 1 of the ladder, and the only rung a human writes.
 *
 * Two things this card does that a plain number field wouldn't. It **shows the current provenance**, so
 * an operator can see they're about to overwrite a modelled estimate rather than a survey (and that
 * doing so is durable — the ETL will never overwrite them back). And it **echoes each value in feet**
 * live, because the entry field is metric and every state bathymetry chart in our region is in feet:
 * that echo is the actual units guard, not the 400 m ceiling the mutation enforces.
 *
 * Empty clears the value *and* its source, which is how "I know the max and not the mean" is expressed —
 * inventing a mean from a max is the inference D68 exists to stop.
 */
function DepthTool({
  body,
  onResult,
}: {
  body: {
    _id: string;
    meanDepthM?: number;
    maxDepthM?: number;
    meanDepthSource?: DepthSource;
    maxDepthSource?: DepthSource;
    depthSourceNote?: string;
  };
  onResult: SetBanner;
}) {
  const setDepth = useMutation(api.waterBodies.setDepth);
  const [mean, setMean] = useState(body.meanDepthM === undefined ? '' : String(body.meanDepthM));
  const [max, setMax] = useState(body.maxDepthM === undefined ? '' : String(body.maxDepthM));
  const [note, setNote] = useState(body.depthSourceNote ?? '');

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

  const shallow = isShallowDepth({
    ...(parsedMean !== undefined && !Number.isNaN(parsedMean) ? { meanDepthM: parsedMean } : {}),
    ...(parsedMax !== undefined && !Number.isNaN(parsedMax) ? { maxDepthM: parsedMax } : {}),
  });

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
          onClick={async () => {
            try {
              await setDepth({
                waterBodyId: body._id as Id<'waterBodies'>,
                ...(parsedMean !== undefined ? { meanDepthM: parsedMean } : {}),
                ...(parsedMax !== undefined ? { maxDepthM: parsedMax } : {}),
                ...(note.trim() ? { sourceNote: note.trim() } : {}),
              });
              onResult({ tone: 'ok', text: 'Depth saved as a survey reading.' });
            } catch (err) {
              onResult({ tone: 'error', text: errorText(err) });
            }
          }}
        >
          Save
        </Button>
      </div>
      <p className="text-foreground-muted text-sm">
        Mean
        <span className="text-foreground">{echo(parsedMean) ?? ' —'}</span> · max
        <span className="text-foreground">{echo(parsedMax) ?? ' —'}</span>. Charts are usually in
        feet; divide by 3.28.
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
      <p className="text-foreground-muted text-sm">
        {body.meanDepthSource === undefined && body.maxDepthSource === undefined
          ? 'No depth on record.'
          : `On record from ${[body.meanDepthSource, body.maxDepthSource]
              .filter((s, i, all): s is DepthSource => s !== undefined && all.indexOf(s) === i)
              .map((s) => DEPTH_SOURCE_LABELS[s])
              .join(', ')}.`}{' '}
        Saving here outranks every automated source and survives a re-import.
      </p>
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
    <ToolCard title="Before first ice — recurring hazards">
      <p className="text-foreground-muted text-sm">
        Last season’s hazards are hidden from the map now. Anything that forms here every winter
        should be promoted to a permanent feature, which no seasonal reset touches —{' '}
        <strong className="text-foreground">this is a safety pass, not tidying up</strong>: a skater
        in November sees a clean map otherwise.
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
