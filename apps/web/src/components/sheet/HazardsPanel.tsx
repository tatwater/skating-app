import { api } from '@skating/convex/api';
import {
  bundledIds,
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
import { Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useCallback, useMemo } from 'react';
import { HazardBundlePrompt } from '../HazardBundlePrompt';
import { buttonVariants } from '../ui/button';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetPanel, SubLabel } from './SheetPanel';
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
 * *Hazards* (A10 §6), the console's half. Three things, top to bottom: *mark one here*, the
 * author's own hazards to bundle (D55, pre-checked), and the tick-through — **you skated past
 * these** when the Report is linked to a track, else **did you see any of these?** over the body's
 * active hazards nearest the chosen put-in. Each answer is one of D52's three verdicts or *didn't
 * look*, and silence is never a vote: only an answer files a confirmation, at Post.
 *
 * **Marking one is a hand-off, as it is on the phone.** Drawing a hazard needs the real map — the
 * drag, the shore snap, the duplicate nudge — and the console is a full-screen route beside it,
 * not inside it. So the link goes to the lake's drawer with the hazard form open, and the Post
 * waits in the store meanwhile; the new pin comes back as a D55 bundle candidate on its own,
 * through the same window query the prompt already makes.
 */
export function HazardsPanel({
  report,
  body,
  dispatch,
  setReport,
  gaps,
  editing,
  timeZone,
}: SectionProps) {
  const sheet = report.sheet;
  const [end] = selectedValues(sheet, 'endTime');
  const me = useQuery(api.profiles.current, {});

  // A server activity's points, when one is linked (an imported track, A10-4's GPX door).
  const mine = useQuery(api.gpsActivities.listMine, report.activityId !== undefined ? {} : 'skip');
  const track = useMemo<PassedTrackPoint[]>(() => {
    if (report.activityId === undefined) return [];
    const activity = mine?.find((a) => a.activityId === report.activityId);
    const path = activity?.path;
    if (path?.type !== 'LineString') return [];
    const start = activity?.startTime ?? 0;
    return (path.coordinates as [number, number][]).map(([lng, lat]) => ({
      lat,
      lng,
      timestamp: start,
    }));
  }, [report.activityId, mine]);

  // Never ask about the author's own pins — bundling is their door (D55). Nothing is offered until
  // the viewer is known: a list that briefly included their own hazards would ask them to confirm
  // a pin they drew, and a tick-through that reshuffles a beat later is worse than one that waits.
  const myId = me?._id;
  const others = useMemo(
    () =>
      me === undefined
        ? []
        : (body?.hazards ?? []).filter((h) => myId === undefined || h.createdByUserId !== myId),
    [body?.hazards, me, myId],
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
    <SheetPanel
      label="Hazards"
      summary={summary}
      collapsed={sheet.collapsed.hazards}
      onToggle={() =>
        dispatch({ type: 'setCollapsed', section: 'hazards', collapsed: !sheet.collapsed.hazards })
      }
      gap={gaps.has('hazards')}
    >
      {body ? (
        <div className="flex flex-col gap-1">
          <Link
            to="/water/$id"
            params={{ id: body.waterBodyId }}
            search={{ hazard: true }}
            className={buttonVariants({ variant: 'outline', className: 'self-start' })}
          >
            Mark one here
          </Link>
          <SheetHint>
            This opens the lake's map to draw it. Your post is kept — come back to it when you're
            done, and the new pin will be offered here.
          </SheetHint>
        </div>
      ) : null}
      {body && !editing && end !== undefined ? (
        <HazardBundlePrompt
          waterBodyId={body.waterBodyId}
          skateEndTime={end.ms}
          {...(sheet.scalars.skateStartTime !== undefined
            ? { skateStartTime: sheet.scalars.skateStartTime }
            : {})}
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
        <div className="flex flex-col gap-2.5">
          <SubLabel>
            {passed.length > 0 ? 'You skated past these' : 'Did you see any of these?'}
          </SubLabel>
          {offered.map(({ hazard, passed: p }) => {
            const verdict = sheet.scalars.passedVerdicts[hazard.id];
            const crossing = isPassageMarker(hazard.type);
            return (
              <div key={hazard.id} className="flex flex-col gap-1.5">
                <p className="font-semibold text-foreground text-sm">
                  {hazardTypeLabel(hazard.type)}
                  {p ? (
                    <span className="font-normal text-foreground-muted text-xs">
                      {'  '}
                      {p.how === 'entered'
                        ? 'you were in it'
                        : p.how === 'crossed'
                          ? 'you crossed it'
                          : `${Math.round(p.nearestMeters)} m off`}
                    </span>
                  ) : null}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {PASSED_VERDICTS.map((v) => (
                    <SheetChip
                      key={v}
                      compact
                      label={crossing && v === 'still_there' ? 'Crossed here' : VERDICT_LABELS[v]}
                      {...(verdict === v ? { tier: 'solid' as const } : {})}
                      onClick={() =>
                        dispatch({ type: 'answerPassed', hazardId: hazard.id, verdict: v })
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <SheetHint>Only what you answer is sent. Not answering is not a vote.</SheetHint>
        </div>
      ) : body && body.hazards.length === 0 ? (
        <SheetHint>No open hazards on this lake right now.</SheetHint>
      ) : null}
    </SheetPanel>
  );
}

function centerOf(hazard: SheetHazard): LatLng {
  return {
    lat: (hazard.bbox.minLat + hazard.bbox.maxLat) / 2,
    lng: (hazard.bbox.minLng + hazard.bbox.maxLng) / 2,
  };
}
