import { api } from '@skating/convex/api';
import {
  humanizeEnum,
  ICE_TYPES,
  type IceType,
  OBSERVED_FROM,
  OBSERVED_FROM_LABELS,
  type ObservedFrom,
  type PeerSuggestions,
  peerLine,
  peerSuggestions,
  type SheetAction,
  type SheetFieldKey,
  type SheetReport,
  SIGHTING_LABELS,
  SIGHTINGS,
  type Sighting,
  SKATE_QUALITIES,
  SKATE_QUALITY_LABELS,
  type SkateQuality,
  SNOW_COVERAGES,
  SNOW_DRIFTS,
  SNOW_DUSTING_CM,
  SNOW_IMPEDIMENTS,
  type SnowCoverage,
  type SnowDrift,
  type SnowImpediment,
  SUITABILITIES,
  SUITABILITY_LABELS,
  SURFACE_TAGS,
  type Suitability,
  type SurfaceTag,
  sectionSummary,
  selectedChips,
  selectedValues,
  sheetReducer,
  sightingAllowedFrom,
  updateReport,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { updateSheet } from '../../lib/sheetStore';
import { Textarea } from '../ui/textarea';
import { AccessPanel } from './AccessPanel';
import { EndTimePanel } from './EndTimePanel';
import { HazardsPanel } from './HazardsPanel';
import { PhotosPanel } from './PhotosPanel';
import { ChipRow, SheetChip } from './SheetChip';
import { SheetHint, SheetPanel, SubLabel } from './SheetPanel';
import type { DispatchOpts, SectionProps } from './sectionProps';
import { ThicknessPanel } from './ThicknessPanel';
import type { SheetBody } from './useSheetBody';
import { WherePicker } from './WherePicker';

/**
 * One Report's panels, in the order that never changes (D187): *How was it?* first, then how it
 * was seen, when, the ice, snow, thickness, hazards, access, photos, a note. Every panel reads and
 * writes the core reducer through `dispatch`; nothing here holds report state of its own.
 *
 * This is mobile's `ReportSections` in web's clothes — deliberately the same sections, the same
 * order, the same sub-labels and the same conditional rows, because the sheet is one thing with
 * two compositions (§10.1). What differs is the composition the console gives it: wider rows, a
 * map that stays beside the panels, and a keyboard.
 */
export function ReportPanels({
  report,
  body,
  gaps,
  editing,
}: {
  report: SheetReport;
  /** The Report's lake, read once by the console and handed down (one body, one subscription set). */
  body: SheetBody | null;
  gaps: SectionProps['gaps'];
  editing: boolean;
}) {
  const timeZone = body?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const id = report.id;
  const dispatch = useCallback(
    (action: SheetAction, opts?: DispatchOpts) =>
      updateSheet((post) =>
        updateReport(post, id, (r) => ({ ...r, sheet: sheetReducer(r.sheet, action) }), opts),
      ),
    [id],
  );
  const setReport = useCallback(
    (update: (r: SheetReport) => SheetReport, opts?: DispatchOpts) =>
      updateSheet((post) => updateReport(post, id, update, opts)),
    [id],
  );
  const props: SectionProps = { report, body, dispatch, setReport, gaps, editing, timeZone };

  // Other skaters' recent reports on the body, as ghosts (§4.4 / D188) — offered once per body.
  usePeerGhosts(props, body);

  return (
    <div className="flex flex-col">
      <HowWasIt {...props} />
      <ObservedFromPanel {...props} />
      <EndTimePanel {...props} />
      <IceAndSurface {...props} />
      <Snow {...props} />
      <ThicknessPanel {...props} />
      <HazardsPanel {...props} />
      <AccessPanel {...props} />
      <PhotosPanel {...props} />
      <Note {...props} />
    </div>
  );
}

// ── How was it? (D190) ───────────────────────────────────────────────────────────────────────────

function HowWasIt({ report, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  return (
    <SheetPanel
      label="How was it?"
      summary={sectionSummary(sheet, 'howWasIt', timeZone)}
      collapsed={sheet.collapsed.howWasIt}
      onToggle={() =>
        dispatch({
          type: 'setCollapsed',
          section: 'howWasIt',
          collapsed: !sheet.collapsed.howWasIt,
        })
      }
      gap={gaps.has('howWasIt')}
    >
      <ChipRow<'quality', SkateQuality>
        sheet={sheet}
        field="quality"
        options={SKATE_QUALITIES}
        label={(q) => SKATE_QUALITY_LABELS[q]}
        onSelect={(q) => dispatch({ type: 'select', field: 'quality', key: q, value: q })}
        onDeselect={(key) => dispatch({ type: 'deselect', field: 'quality', key })}
      />
      <SubLabel>Who is it for?</SubLabel>
      <ChipRow<'suitability', Suitability>
        sheet={sheet}
        field="suitability"
        options={SUITABILITIES}
        label={(s) => SUITABILITY_LABELS[s]}
        danger="dont_go"
        onSelect={(s) => dispatch({ type: 'select', field: 'suitability', key: s, value: s })}
        onDeselect={(key) => dispatch({ type: 'deselect', field: 'suitability', key })}
      />
    </SheetPanel>
  );
}

// ── How did you see it? (D191) ───────────────────────────────────────────────────────────────────

function ObservedFromPanel({ report, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const [from] = selectedValues(sheet, 'observedFrom');
  return (
    <SheetPanel
      label="How did you see it?"
      summary={sectionSummary(sheet, 'observedFrom', timeZone)}
      collapsed={sheet.collapsed.observedFrom}
      onToggle={() =>
        dispatch({
          type: 'setCollapsed',
          section: 'observedFrom',
          collapsed: !sheet.collapsed.observedFrom,
        })
      }
      gap={gaps.has('observedFrom')}
    >
      <ChipRow<'observedFrom', ObservedFrom>
        sheet={sheet}
        field="observedFrom"
        options={OBSERVED_FROM}
        label={(v) => OBSERVED_FROM_LABELS[v]}
        onSelect={(v) => dispatch({ type: 'select', field: 'observedFrom', key: v, value: v })}
        onDeselect={(key) => dispatch({ type: 'deselect', field: 'observedFrom', key })}
      />
      {sightingAllowedFrom(from) ? (
        <>
          <SubLabel>What did you see?</SubLabel>
          <ChipRow<'sighting', Sighting>
            sheet={sheet}
            field="sighting"
            options={SIGHTINGS}
            label={(v) => SIGHTING_LABELS[v]}
            onSelect={(v) => dispatch({ type: 'select', field: 'sighting', key: v, value: v })}
            onDeselect={(key) => dispatch({ type: 'deselect', field: 'sighting', key })}
          />
        </>
      ) : null}
    </SheetPanel>
  );
}

// ── Ice and surface, with where (D193) ───────────────────────────────────────────────────────────

function IceAndSurface({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const [whereFor, setWhereFor] = useState<{
    field: 'iceTypes' | 'surfaceTags';
    key: string;
  } | null>(null);
  const peers = usePeers(body);
  const iceLine = peers ? peerLine(peers.iceTypes, peers.reporters) : null;
  const surfaceLine = peers ? peerLine(peers.surfaceTags, peers.reporters) : null;
  const selectedIce = selectedChips(sheet, 'iceTypes');
  const selectedSurface = selectedChips(sheet, 'surfaceTags');
  const whereChip =
    whereFor === null
      ? null
      : (whereFor.field === 'iceTypes' ? selectedIce : selectedSurface).find(
          (c) => c.key === whereFor.key,
        );

  return (
    <SheetPanel
      label="Ice and surface"
      summary={sectionSummary(sheet, 'iceAndSurface', timeZone)}
      collapsed={sheet.collapsed.iceAndSurface}
      onToggle={() =>
        dispatch({
          type: 'setCollapsed',
          section: 'iceAndSurface',
          collapsed: !sheet.collapsed.iceAndSurface,
        })
      }
      gap={gaps.has('iceAndSurface')}
    >
      {iceLine ? <SheetHint>{iceLine}</SheetHint> : null}
      <ChipRow<'iceTypes', IceType>
        sheet={sheet}
        field="iceTypes"
        options={ICE_TYPES}
        label={humanizeEnum}
        onSelect={(t) => {
          dispatch({ type: 'select', field: 'iceTypes', key: t, value: { type: t } });
          setWhereFor({ field: 'iceTypes', key: t });
        }}
        onDeselect={(key) => {
          dispatch({ type: 'deselect', field: 'iceTypes', key });
          if (whereFor?.key === key) setWhereFor(null);
        }}
      />
      <SubLabel>Surface</SubLabel>
      {surfaceLine ? <SheetHint>{surfaceLine}</SheetHint> : null}
      <ChipRow<'surfaceTags', SurfaceTag>
        sheet={sheet}
        field="surfaceTags"
        options={SURFACE_TAGS}
        label={humanizeEnum}
        onSelect={(t) => {
          dispatch({ type: 'select', field: 'surfaceTags', key: t, value: { type: t } });
          setWhereFor({ field: 'surfaceTags', key: t });
        }}
        onDeselect={(key) => {
          dispatch({ type: 'deselect', field: 'surfaceTags', key });
          if (whereFor?.key === key) setWhereFor(null);
        }}
      />
      {selectedIce.length + selectedSurface.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground-muted text-xs">Where?</span>
            {[
              ...selectedIce.map((c) => ({ field: 'iceTypes' as const, c })),
              ...selectedSurface.map((c) => ({ field: 'surfaceTags' as const, c })),
            ].map(({ field, c }) => (
              <SheetChip
                key={`${field}:${c.key}`}
                compact
                label={`${humanizeEnum(c.value.type)}${c.value.where ? ' ·' : ''}`}
                {...(whereFor?.field === field && whereFor.key === c.key
                  ? { tier: 'solid' as const }
                  : {})}
                onClick={() =>
                  setWhereFor(
                    whereFor?.field === field && whereFor.key === c.key
                      ? null
                      : { field, key: c.key },
                  )
                }
              />
            ))}
          </div>
          {whereFor && whereChip ? (
            <WherePicker
              {...(whereChip.value.where !== undefined ? { where: whereChip.value.where } : {})}
              body={body}
              onChange={(where) =>
                dispatch({
                  type: 'setWhere',
                  field: whereFor.field,
                  key: whereFor.key,
                  ...(where !== undefined ? { where } : {}),
                })
              }
            />
          ) : null}
        </div>
      ) : null}
    </SheetPanel>
  );
}

// ── Snow (D194) ──────────────────────────────────────────────────────────────────────────────────

const COVERAGE_LABELS: Record<SnowCoverage, string> = {
  none: 'None',
  patches: 'Patches',
  lanes: 'Lanes through it',
  mostly: 'Mostly',
  everywhere: 'Everywhere',
};
const IMPEDIMENT_LABELS: Record<SnowImpediment, string> = {
  didnt_matter: "Didn't matter",
  slowed_me: 'Slowed me',
  avoided_areas: 'Avoided areas',
};
const DRIFT_LABELS: Record<SnowDrift, string> = {
  none: 'No drifts',
  avoidable: 'Avoidable',
  everywhere: 'Everywhere',
};
const DEPTH_INCHES = [1, 2, 4, 6, 8, 12] as const;

function Snow({ report, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const [coverage] = selectedValues(sheet, 'snowCoverage');
  const depth = sheet.scalars.snowDepthCm;
  const none = coverage === 'none';
  return (
    <SheetPanel
      label="Snow"
      summary={sectionSummary(sheet, 'snow', timeZone)}
      collapsed={sheet.collapsed.snow}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'snow', collapsed: !sheet.collapsed.snow })
      }
      gap={gaps.has('snow')}
    >
      <ChipRow<'snowCoverage', SnowCoverage>
        sheet={sheet}
        field="snowCoverage"
        options={SNOW_COVERAGES}
        label={(v) => COVERAGE_LABELS[v]}
        onSelect={(v) => dispatch({ type: 'select', field: 'snowCoverage', key: v, value: v })}
        onDeselect={(key) => dispatch({ type: 'deselect', field: 'snowCoverage', key })}
      />
      {coverage !== undefined && !none ? (
        <>
          <SubLabel>Did it get in the way?</SubLabel>
          <ChipRow<'snowImpediment', SnowImpediment>
            sheet={sheet}
            field="snowImpediment"
            options={SNOW_IMPEDIMENTS}
            label={(v) => IMPEDIMENT_LABELS[v]}
            onSelect={(v) =>
              dispatch({ type: 'select', field: 'snowImpediment', key: v, value: v })
            }
            onDeselect={(key) => dispatch({ type: 'deselect', field: 'snowImpediment', key })}
          />
          <SubLabel>Drifts</SubLabel>
          <ChipRow<'snowDrifts', SnowDrift>
            sheet={sheet}
            field="snowDrifts"
            options={SNOW_DRIFTS}
            label={(v) => DRIFT_LABELS[v]}
            onSelect={(v) => dispatch({ type: 'select', field: 'snowDrifts', key: v, value: v })}
            onDeselect={(key) => dispatch({ type: 'deselect', field: 'snowDrifts', key })}
          />
          <SubLabel>How deep?</SubLabel>
          <div className="flex flex-wrap gap-2">
            <SheetChip
              compact
              label="A dusting"
              {...(depth === SNOW_DUSTING_CM ? { tier: 'solid' as const } : {})}
              onClick={() =>
                dispatch({
                  type: 'setScalar',
                  key: 'snowDepthCm',
                  value: depth === SNOW_DUSTING_CM ? undefined : SNOW_DUSTING_CM,
                })
              }
            />
            {DEPTH_INCHES.map((inches) => {
              const cm = Math.round(inches * 2.54 * 10) / 10;
              return (
                <SheetChip
                  key={inches}
                  compact
                  label={`~${inches}"`}
                  {...(depth === cm ? { tier: 'solid' as const } : {})}
                  onClick={() =>
                    dispatch({
                      type: 'setScalar',
                      key: 'snowDepthCm',
                      value: depth === cm ? undefined : cm,
                    })
                  }
                />
              );
            })}
            <SheetChip
              compact
              label="Plowed path"
              {...(sheet.scalars.plowedPath ? { tier: 'solid' as const } : {})}
              onClick={() =>
                dispatch({
                  type: 'setScalar',
                  key: 'plowedPath',
                  value: sheet.scalars.plowedPath ? undefined : true,
                })
              }
            />
          </div>
        </>
      ) : null}
    </SheetPanel>
  );
}

// ── A note about this lake ───────────────────────────────────────────────────────────────────────

function Note({ report, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  return (
    <SheetPanel
      label="Anything else about this lake"
      summary={sectionSummary(sheet, 'writing', timeZone)}
      collapsed={sheet.collapsed.writing}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'writing', collapsed: !sheet.collapsed.writing })
      }
      gap={gaps.has('writing')}
    >
      <Textarea
        value={sheet.scalars.notes}
        onChange={(e) => dispatch({ type: 'setScalar', key: 'notes', value: e.target.value })}
        placeholder="A line the lake's page shows on its own — the story goes up top."
        rows={3}
      />
    </SheetPanel>
  );
}

// ── Peers (§4.4) ─────────────────────────────────────────────────────────────────────────────────

function usePeers(body: SheetBody | null): PeerSuggestions | null {
  const me = useQuery(api.profiles.current, {});
  return useMemo(() => {
    if (!body || body.recentCards.length === 0) return null;
    return peerSuggestions(body.recentCards, {
      now: Date.now(),
      ...(me?.username !== undefined ? { authorUsername: me.username } : {}),
    });
  }, [body, me?.username]);
}

/** Offer the peers' values as ghosts (D188), once per body — a click makes one solid; nothing else does. */
function usePeerGhosts({ dispatch, report }: SectionProps, body: SheetBody | null) {
  const peers = usePeers(body);
  const batches = useMemo<SheetAction[]>(() => {
    if (!peers || peers.reporters === 0) return [];
    const suggest = (
      field: SheetFieldKey,
      values: { key: string; value: unknown }[],
    ): SheetAction[] =>
      values.length > 0 ? [{ type: 'suggest', field, source: 'peer', values }] : [];
    return [
      ...suggest(
        'iceTypes',
        peers.iceTypes.map((v) => ({ key: v.key, value: { type: v.key } })),
      ),
      ...suggest(
        'surfaceTags',
        peers.surfaceTags.map((v) => ({ key: v.key, value: { type: v.key } })),
      ),
      ...suggest(
        'quality',
        peers.quality.map((v) => ({ key: v.key, value: v.key })),
      ),
      ...suggest(
        'suitability',
        peers.suitability.map((v) => ({ key: v.key, value: v.key })),
      ),
    ];
  }, [peers]);
  // Once per (body, set of reporters): a re-render with the same peers offers nothing new. The
  // console keys `ReportPanels` by the Report, so this ref is one leg's memory — two legs on the
  // same lake (*+ an earlier visit*) each get the offer, which a body-only key would deny the
  // second of.
  const key = `${report.sheet.waterBodyId ?? ''}:${peers?.reporters ?? 0}`;
  const batchesRef = useRef(batches);
  batchesRef.current = batches;
  const offered = useRef<string | null>(null);
  useEffect(() => {
    if (offered.current === key) return;
    offered.current = key;
    // Quiet: an offer is the sheet's, and must not make an untouched sheet read as the author's work.
    for (const action of batchesRef.current) dispatch(action, { quiet: true });
  });
}
