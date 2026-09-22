import { api } from '@skating/convex/api';
import {
  haversineMeters,
  hazardTypeLabel,
  isPassageMarker,
  type LatLng,
  optOutsFromSavedRefs,
  PASSED_VERDICTS,
  type PassedHazard,
  type PassedTrackPoint,
  type PassedVerdict,
  passedHazards,
  sectionSummary,
  selectedValues,
  toggleBundleOptOut,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';
import { getTrack } from '../../lib/draftStore';
import { bundledIds } from '../../lib/sheetModel';
import { HazardBundlePrompt } from '../HazardBundlePrompt';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetSection, SubLabel } from './SheetSection';
import type { SectionProps } from './sectionProps';
import type { SheetHazard } from './useSheetBody';

const VERDICT_LABELS: Record<PassedVerdict, string> = {
  still_there: 'Still there',
  healing_unsafe: 'Healing, not safe',
  fully_healed: 'Fully healed',
  didnt_look: "Didn't look",
};

/** How many of the body's hazards the no-track list offers — nearest to the put-in first (§6 (d)). */
const NO_TRACK_LIST_MAX = 8;

/**
 * *Hazards* (A10 §6). Three things, top to bottom: *mark one here* (the map's `HazardCapture`,
 * reached by a hand-off — the sheet keeps its state, D187); the author's own hazards to bundle
 * (D55, pre-checked); and the tick-through — **you skated past these** when a track is known
 * (§6.2, the track ∩ each active hazard's footprint), else **did you see any of these?** over the
 * body's active hazards nearest the chosen put-in (§6 (d)). Each answer is one of D52's three
 * verdicts or *didn't look*, and silence is never a vote: only an answer files a confirmation
 * (`via: 'report_flow'`), at Post, through the hazard queue.
 */
export function HazardsSection({
  report,
  body,
  dispatch,
  setReport,
  gaps,
  editing,
  timeZone,
}: SectionProps) {
  const router = useRouter();
  const sheet = report.sheet;
  const [end] = selectedValues(sheet, 'endTime');
  const me = useQuery(api.profiles.current, {});

  // The track's points: a local recording's, or a server activity's from the author's own list.
  const mine = useQuery(api.gpsActivities.listMine, report.activityId !== undefined ? {} : 'skip');
  const track = useMemo<PassedTrackPoint[]>(() => {
    if (report.trackDraftId !== undefined) {
      const queued = getTrack(report.trackDraftId);
      return (queued?.points ?? []).map((p) => ({ lat: p.lat, lng: p.lng, timestamp: p.t }));
    }
    if (report.activityId !== undefined) {
      const activity = mine?.find((a) => a.activityId === report.activityId);
      const path = activity?.path;
      if (path?.type === 'LineString') {
        const start = activity?.startTime ?? 0;
        return (path.coordinates as [number, number][]).map(([lng, lat]) => ({
          lat,
          lng,
          timestamp: start,
        }));
      }
    }
    return [];
  }, [report.trackDraftId, report.activityId, mine]);

  // Never ask about the author's own pins — bundling is their door (D55).
  const others = useMemo(
    () => (body?.hazards ?? []).filter((h) => me === undefined || h.createdByUserId !== me?._id),
    [body?.hazards, me],
  );
  const passed = useMemo<PassedHazard[]>(
    () => (track.length > 0 ? passedHazards(track, others) : []),
    [track, others],
  );
  const anchor: LatLng | undefined =
    sheet.scalars.point ??
    body?.putIns.find((p) => p.id === sheet.scalars.putInId)?.coord ??
    body?.frame?.origin;
  const offered: { hazard: SheetHazard; passed?: PassedHazard }[] = useMemo(() => {
    if (passed.length > 0) {
      return passed.flatMap((p) => {
        const hazard = others.find((h) => h.id === p.hazardId);
        return hazard ? [{ hazard, passed: p }] : [];
      });
    }
    if (!anchor) return others.slice(0, NO_TRACK_LIST_MAX).map((hazard) => ({ hazard }));
    return [...others]
      .map((hazard) => ({ hazard, meters: haversineMeters(anchor, centerOf(hazard)) }))
      .sort((a, b) => a.meters - b.meters)
      .slice(0, NO_TRACK_LIST_MAX)
      .map(({ hazard }) => ({ hazard }));
  }, [passed, others, anchor]);

  const bundle = bundledIds(report);
  const onCandidates = useCallback(
    (ids: string[]) =>
      setReport(
        (r) => {
          const applySaved =
            r.savedHazardRefs !== undefined && r.bundleCandidateIds.length === 0 && ids.length > 0;
          return {
            ...r,
            bundleCandidateIds: ids,
            ...(applySaved
              ? { unbundledHazardIds: optOutsFromSavedRefs(ids, r.savedHazardRefs ?? []) }
              : {}),
          };
        },
        // The candidates arriving is the prompt's doing, not an edit.
        { quiet: true },
      ),
    [setReport],
  );

  const summaryBase = sectionSummary(sheet, 'hazards', timeZone);
  const summary = [summaryBase, bundle.length > 0 ? `${bundle.length} of yours` : '']
    .filter(Boolean)
    .join(' · ');

  return (
    <SheetSection
      label="Hazards"
      summary={summary}
      collapsed={sheet.collapsed.hazards}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'hazards', collapsed: !sheet.collapsed.hazards })
      }
      gap={gaps.has('hazards')}
    >
      {body ? (
        <Button
          size="$3"
          alignSelf="flex-start"
          onPress={() =>
            router.navigate({
              pathname: '/water/[id]',
              // A fresh stamp per tap: the drawer stays mounted, and only a new value reopens the picker.
              params: { id: body.waterBodyId, hazard: String(Date.now()) },
            })
          }
        >
          Mark one here
        </Button>
      ) : null}
      {body && !editing && end !== undefined ? (
        <HazardBundlePrompt
          waterBodyId={body.waterBodyId}
          skateEndTime={end.ms}
          skateStartTime={sheet.scalars.skateStartTime}
          selectedIds={bundle}
          onToggle={(hazardId, checked) =>
            setReport((r) => ({
              ...r,
              unbundledHazardIds: toggleBundleOptOut(r.unbundledHazardIds, hazardId, checked),
            }))
          }
          onCandidates={onCandidates}
        />
      ) : null}
      {offered.length > 0 ? (
        <YStack gap="$2.5">
          <SubLabel>
            {passed.length > 0 ? 'You skated past these' : 'Did you see any of these?'}
          </SubLabel>
          {offered.map(({ hazard, passed: p }) => {
            const verdict = sheet.scalars.passedVerdicts[hazard.id];
            const crossing = isPassageMarker(hazard.type);
            return (
              <YStack key={hazard.id} gap="$1.5">
                <Text color="$foreground" fontSize={13} fontWeight="600">
                  {hazardTypeLabel(hazard.type)}
                  {p ? (
                    <Text color="$foregroundMuted" fontSize={12} fontWeight="400">
                      {'  '}
                      {p.how === 'entered'
                        ? 'you were in it'
                        : p.how === 'crossed'
                          ? 'you crossed it'
                          : `${Math.round(p.nearestMeters)} m off`}
                    </Text>
                  ) : null}
                </Text>
                <XStack gap="$2" flexWrap="wrap">
                  {PASSED_VERDICTS.map((v) => (
                    <SheetChip
                      key={v}
                      compact
                      label={crossing && v === 'still_there' ? 'Crossed here' : VERDICT_LABELS[v]}
                      tier={verdict === v ? 'solid' : undefined}
                      onPress={() =>
                        dispatch({ type: 'answerPassed', hazardId: hazard.id, verdict: v })
                      }
                    />
                  ))}
                </XStack>
              </YStack>
            );
          })}
          <SheetHint>Only what you answer is sent. Not answering is not a vote.</SheetHint>
        </YStack>
      ) : body && body.hazards.length === 0 ? (
        <SheetHint>No open hazards on this lake right now.</SheetHint>
      ) : null}
    </SheetSection>
  );
}

function centerOf(hazard: SheetHazard): LatLng {
  return {
    lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
    lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
  };
}
