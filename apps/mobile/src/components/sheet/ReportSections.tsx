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
import { Text, XStack, YStack } from 'tamagui';
import { updateSheet } from '../../lib/sheetStore';
import { TextArea } from '../ThemedInputs';
import { AccessSection } from './AccessSection';
import { EndTimeSection } from './EndTimeSection';
import { HazardsSection } from './HazardsSection';
import { PhotosSection } from './PhotosSection';
import { ChipRow, SheetChip } from './SheetChip';
import { SheetHint, SheetSection, SubLabel } from './SheetSection';
import type { DispatchOpts, SectionProps } from './sectionProps';
import { ThicknessSection } from './ThicknessSection';
import { type SheetBody, useSheetBody } from './useSheetBody';
import { type WhereCard, WhereCards } from './WhereCards';

/**
 * One Report's sections, in the order that never changes (D187): *How was it?* first, then how it
 * was seen, when, the ice, snow, thickness, hazards, access, photos, a note. Every section reads
 * and writes the core reducer through `dispatch`; nothing here holds report state of its own.
 */
export function ReportSections({
  report,
  gaps,
  editing,
}: {
  report: SheetReport;
  gaps: SectionProps['gaps'];
  editing: boolean;
}) {
  const body = useSheetBody(report.sheet.waterBodyId);
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
    <YStack>
      <HowWasIt {...props} />
      <ObservedFromSection {...props} />
      <EndTimeSection {...props} />
      <IceAndSurface {...props} />
      <Snow {...props} />
      <ThicknessSection {...props} />
      <HazardsSection {...props} />
      <AccessSection {...props} />
      <PhotosSection {...props} />
      <Note {...props} />
    </YStack>
  );
}

// ── How was it? (D190) ───────────────────────────────────────────────────────────────────────────

function HowWasIt({ report, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  return (
    <SheetSection
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
    </SheetSection>
  );
}

// ── How did you see it? (D191) ───────────────────────────────────────────────────────────────────

function ObservedFromSection({ report, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const [from] = selectedValues(sheet, 'observedFrom');
  return (
    <SheetSection
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
    </SheetSection>
  );
}

// ── Ice and surface, with where (D193) ───────────────────────────────────────────────────────────

function IceAndSurface({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  // The where question: open or not, and which card is up. Never opened by a chip tap alone — a
  // five-chip reporter is not pulled into it five times — but the row's *Where?* chip opens it on
  // the first chip still unanswered (founder call 2026-09-23).
  const [asking, setAsking] = useState(false);
  const [activeCard, setActiveCard] = useState<string | null>(null);
  const peers = usePeers(body);
  const iceLine = peers ? peerLine(peers.iceTypes, peers.reporters) : null;
  const surfaceLine = peers ? peerLine(peers.surfaceTags, peers.reporters) : null;
  const selectedIce = selectedChips(sheet, 'iceTypes');
  const selectedSurface = selectedChips(sheet, 'surfaceTags');
  const cards: WhereCard[] = [
    ...selectedIce.map((c) => ({ field: 'iceTypes' as const, c })),
    ...selectedSurface.map((c) => ({ field: 'surfaceTags' as const, c })),
  ].map(({ field, c }) => ({
    id: `${field}:${c.key}`,
    label: humanizeEnum(c.value.type),
    where: c.value.where,
    onChange: (where) => dispatch({ type: 'setWhere', field, key: c.key, where }),
  }));
  const whereMark = (field: 'iceTypes' | 'surfaceTags') => (key: string) => {
    const chip = (field === 'iceTypes' ? selectedIce : selectedSurface).find((c) => c.key === key);
    const where = chip?.value.where;
    return (
      <Text
        color="$background"
        fontSize={10}
        opacity={where ? 0.9 : 0.5}
        accessibilityElementsHidden
      >
        {where?.sector ? `◆ ${where.sector}` : where ? '◆' : '◇'}
      </Text>
    );
  };
  const unanswered = cards.filter((c) => c.where === undefined).length;

  return (
    <SheetSection
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
        trailing={whereMark('iceTypes')}
        onSelect={(t) =>
          dispatch({ type: 'select', field: 'iceTypes', key: t, value: { type: t } })
        }
        onDeselect={(key) => {
          dispatch({ type: 'deselect', field: 'iceTypes', key });
          if (activeCard === `iceTypes:${key}`) setActiveCard(null);
        }}
      />
      <SubLabel>Surface</SubLabel>
      {surfaceLine ? <SheetHint>{surfaceLine}</SheetHint> : null}
      <ChipRow<'surfaceTags', SurfaceTag>
        sheet={sheet}
        field="surfaceTags"
        options={SURFACE_TAGS}
        label={humanizeEnum}
        trailing={whereMark('surfaceTags')}
        onSelect={(t) =>
          dispatch({ type: 'select', field: 'surfaceTags', key: t, value: { type: t } })
        }
        onDeselect={(key) => {
          dispatch({ type: 'deselect', field: 'surfaceTags', key });
          if (activeCard === `surfaceTags:${key}`) setActiveCard(null);
        }}
      />
      {cards.length > 0 && !asking ? (
        <XStack gap="$2" alignItems="center" flexWrap="wrap">
          <SubLabel>Where?</SubLabel>
          <SheetChip
            compact
            label={
              unanswered === 0
                ? 'Every chip has a where'
                : `${unanswered} of ${cards.length} to answer`
            }
            onPress={() => {
              setActiveCard(
                cards.find((c) => c.where === undefined)?.id ?? (cards[0] as WhereCard).id,
              );
              setAsking(true);
            }}
          />
        </XStack>
      ) : null}
      <WhereCards
        cards={cards}
        body={body}
        open={asking && cards.length > 0}
        onClose={() => setAsking(false)}
        activeId={asking ? (activeCard ?? cards[0]?.id ?? null) : null}
        onActivate={setActiveCard}
      />
    </SheetSection>
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
    <SheetSection
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
          <XStack gap={6} flexWrap="wrap">
            <SheetChip
              compact
              label="A dusting"
              tier={depth === SNOW_DUSTING_CM ? 'solid' : undefined}
              onPress={() =>
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
                  tier={depth === cm ? 'solid' : undefined}
                  onPress={() =>
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
              tier={sheet.scalars.plowedPath ? 'solid' : undefined}
              onPress={() =>
                dispatch({
                  type: 'setScalar',
                  key: 'plowedPath',
                  value: sheet.scalars.plowedPath ? undefined : true,
                })
              }
            />
          </XStack>
        </>
      ) : null}
    </SheetSection>
  );
}

// ── A note about this lake ───────────────────────────────────────────────────────────────────────

function Note({ report, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  return (
    <SheetSection
      label="Anything else about this lake"
      summary={sectionSummary(sheet, 'writing', timeZone)}
      collapsed={sheet.collapsed.writing}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'writing', collapsed: !sheet.collapsed.writing })
      }
      gap={gaps.has('writing')}
    >
      <TextArea
        value={sheet.scalars.notes}
        onChangeText={(notes) => dispatch({ type: 'setScalar', key: 'notes', value: notes })}
        placeholder="A line the lake's page shows on its own — the story goes up top."
        numberOfLines={3}
      />
    </SheetSection>
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

/** Offer the peers' values as ghosts (D188), once per body — a tap makes one solid; nothing else does. */
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
  // Once per (body, set of reporters): a re-render with the same peers offers nothing new.
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
