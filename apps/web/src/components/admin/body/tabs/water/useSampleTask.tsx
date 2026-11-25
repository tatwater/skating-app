import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { LatLng } from '@skating/core';
import { useMutation } from 'convex/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { BBoxLike } from '@/lib/mapSurface';
import { type MapToolClaim, useClaimMapTool } from '../../frame/mapTool';
import { useTabAction } from '../useTabAction';
import { SampleTask } from './SampleTask';
import {
  type SampleDraft,
  sampleGeometry,
  sampleModeBar,
  sampleSavedTitle,
  startSampleDraft,
  suggest,
} from './sampleDraft';

/**
 * **The sample-point task, wired** (B01-6b, D300): the Water tab's suggested grid (`sampleDraft`),
 * its claim on the console map (no engine; the grid is the draft, as hollow rings), and the two
 * writes, each through the tab's writer (`useTabAction`) with Undo as the server offers it:
 *
 * - **Save** sends the grid (`waterBodies.setWeatherSamplePoints`) with the points it was suggested
 *   over as `expected`: refused, in a toast, if someone changed them meanwhile, and the task stays.
 * - **Clear** sends no points, with the points shown as `expected`: back to the interior point.
 *
 * Esc (or the mode bar's cap) and *Discard* let the suggestion go; nothing was saved.
 */
export function useSampleTask({
  bodyId,
  outline,
  stored,
  box,
}: {
  bodyId: string;
  /** The body's outline; until it is read, nothing can be suggested. */
  outline: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  /** The points set by hand now (none: the interior point is used). */
  stored: readonly LatLng[];
  box: BBoxLike | null;
}): {
  task: ReactNode;
  /** Open the task with a grid at the default spacing; absent until the outline is read. */
  start: (() => void) | undefined;
  /** Clear the points set by hand. */
  clear: () => Promise<boolean>;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const [draft, setDraft] = useState<SampleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const discard = useCallback(() => setDraft(null), []);

  const claim = useMemo((): MapToolClaim | null => {
    if (draft === null) return null;
    const bar = sampleModeBar(draft);
    return {
      session: `samples:${draft.session}`,
      engine: { kind: 'none' },
      mode: bar.mode,
      line: bar.line,
      draft: sampleGeometry(draft),
      focus: draft.focus,
      onExit: discard,
    };
  }, [draft, discard]);
  useClaimMapTool(claim);

  const setPoints = useMutation(api.waterBodies.setWeatherSamplePoints);
  const { act } = useTabAction(bodyId);
  const target = { targetType: 'waterbody', targetId: bodyId } as const;

  // As the bay task's: clearing the draft after a save is the task's, only while it is still open.
  const openSession = useRef<number | null>(null);
  useEffect(() => {
    openSession.current = draft?.session ?? null;
  }, [draft?.session]);
  useEffect(
    () => () => {
      openSession.current = null;
    },
    [],
  );

  const send = (points: LatLng[], expected: LatLng[]) =>
    act(() => setPoints({ waterBodyId, points, expected }), {
      title: sampleSavedTitle(points),
      ...(points.length === 0
        ? { description: 'The weather is read at the interior point again.' }
        : {}),
      target,
    });

  const save = async () => {
    if (draft === null || saving || draft.points.length === 0) return;
    const d = draft;
    setSaving(true);
    try {
      const landed = await send(d.points, d.expected);
      // A suggestion re-run since the send is a new one: it stays up.
      if (landed && openSession.current === d.session) setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const task =
    draft === null || outline === null ? null : (
      <SampleTask
        draft={draft}
        saving={saving}
        onSpacing={(spacing) => setDraft((d) => (d === null ? d : { ...d, spacing }))}
        onSuggest={() => setDraft((d) => (d === null ? d : suggest(d, outline)))}
        onSave={() => void save()}
        onDiscard={discard}
      />
    );

  return {
    task,
    start: outline === null ? undefined : () => setDraft(startSampleDraft(outline, stored, box)),
    clear: () =>
      send(
        [],
        stored.map((p) => ({ lat: p.lat, lng: p.lng })),
      ),
  };
}
