import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation } from 'convex/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { BBoxLike } from '@/lib/mapSurface';
import { type MapToolClaim, useClaimMapTool } from '../../frame/mapTool';
import { useTabAction } from '../useTabAction';
import { FeatureTask } from './FeatureTask';
import {
  type FeatureDraft,
  featureModeBar,
  featurePreview,
  featureReason,
  featureSavedTitle,
  featureShape,
  redrawTarget,
  type StoredFeatureShape,
  saveBlocker,
  startFeatureDraft,
  startRedrawDraft,
  withPaste,
  withPoint,
  withTraced,
  withWay,
} from './featureDraft';

/**
 * **The known-feature task, wired** (B01-6b, D313): the Hazards tab's draft (`featureDraft`), its
 * claim on the console map (`frame/mapTool`), and its save.
 *
 * - **Starting**: *Add a feature* (F), or *Edit shape* on a feature, which opens on its own shape.
 * - **The claim**: while a draft is up the map draws with its way's engine — a ring for an outline,
 *   a point for a point, a line for a line, none for a paste — the mode bar says what to do next,
 *   and the footprint the save would store is drawn as the draft. Esc (or the bar's cap) discards.
 * - **Saving** goes through the tab's writer (`useTabAction`): a new feature
 *   (`bodyFeatures.create`) or a redraw (`bodyFeatures.updateShape`), each with the old editor's
 *   reason. The receipt names the feature, with Undo as the server offers it; once it lands the
 *   feature is lit.
 */

/** A feature row as `bodyFeatures.listForBody` reads it, as far as the task needs. */
export type FeatureToolRow = { _id: string; type: string; bbox?: BBoxLike } & StoredFeatureShape;

export function useFeatureTask({
  bodyId,
  rows,
  onSaved,
}: {
  bodyId: string;
  rows: readonly FeatureToolRow[] | undefined;
  /** The feature saved: the tab lights it. */
  onSaved: (featureId: string) => void;
}): {
  draft: FeatureDraft | null;
  task: ReactNode;
  startNew: () => void;
  redraw: (featureId: string) => void;
} {
  const waterBodyId = bodyId as Id<'waterBodies'>;
  const [draft, setDraft] = useState<FeatureDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const step = (f: (d: FeatureDraft) => FeatureDraft) => setDraft((d) => (d === null ? d : f(d)));

  const discard = useCallback(() => setDraft(null), []);

  const claim = useMemo((): MapToolClaim | null => {
    if (draft === null) return null;
    const bar = featureModeBar(draft);
    const g = draft.geometry;
    const unavailable = () => setDraft((d) => (d === null ? d : { ...d, unavailable: true }));
    const engine: MapToolClaim['engine'] =
      draft.way === 'point'
        ? {
            kind: 'point',
            // The mark as it stands, so a map re-created mid-task puts back where it was placed.
            ...(g?.type === 'Point'
              ? { point: { lng: g.coordinates[0] as number, lat: g.coordinates[1] as number } }
              : {}),
            onPick: (p) => setDraft((d) => (d === null ? d : withPoint(d, p))),
          }
        : draft.way === 'line' && !draft.unavailable
          ? {
              kind: 'line',
              ...(g?.type === 'LineString' ? { line: g } : {}),
              onChange: (line) => setDraft((d) => (d === null ? d : withTraced(d, line))),
              onUnavailable: unavailable,
            }
          : draft.way === 'polygon' && !draft.unavailable
            ? {
                kind: 'ring',
                ...(g?.type === 'Polygon' ? { polygon: g } : {}),
                onChange: (polygon) => setDraft((d) => (d === null ? d : withTraced(d, polygon))),
                onUnavailable: unavailable,
              }
            : { kind: 'none' };
    return {
      session: `feature:${draft.session}:${draft.unavailable ? 'paste' : draft.way}`,
      engine,
      mode: bar.mode,
      line: bar.line,
      draft: featurePreview(draft),
      focus: draft.focus,
      onExit: discard,
    };
  }, [draft, discard]);
  useClaimMapTool(claim);

  const create = useMutation(api.bodyFeatures.create);
  const updateShape = useMutation(api.bodyFeatures.updateShape);
  const { act } = useTabAction(bodyId);

  // As the bay task's: what a save does after its write (clear the draft, light the feature) is the
  // task's, so it happens only while that same task is still open. The write and receipt land anyway.
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

  const save = async () => {
    if (draft === null || saving || saveBlocker(draft) !== null) return;
    const d = draft;
    const shape = featureShape(d);
    if (shape === null) return;
    const title = featureSavedTitle(d);
    const target = (id: string) => ({ targetType: 'bodyFeature', targetId: id }) as const;
    const sized = {
      geometryKind: shape.geometryKind,
      geometry: shape.geometry as never,
      ...(shape.radiusMeters !== undefined ? { radiusMeters: shape.radiusMeters } : {}),
      ...(shape.bufferMeters !== undefined ? { bufferMeters: shape.bufferMeters } : {}),
      reason: featureReason(d),
    };
    let savedId: string | null = null;
    setSaving(true);
    try {
      const t = d.target;
      const landed =
        t.kind === 'redraw'
          ? await act(
              async () => {
                savedId = t.featureId;
                return updateShape({
                  bodyFeatureId: t.featureId as Id<'bodyFeatures'>,
                  ...sized,
                });
              },
              { title, target: target(t.featureId) },
            )
          : await act(
              async () => {
                const note = d.note.trim();
                const id = await create({
                  waterBodyId,
                  type: d.type,
                  ...sized,
                  ...(note !== '' ? { note } : {}),
                });
                savedId = id;
                return id;
              },
              (id) => ({ title, target: target(id) }),
            );
      if (!landed || openSession.current !== d.session) return;
      setDraft(null);
      if (savedId !== null) onSaved(savedId);
    } finally {
      setSaving(false);
    }
  };

  const task =
    draft === null ? null : (
      <FeatureTask
        draft={draft}
        saving={saving}
        onType={(type) => step((x) => ({ ...x, type }))}
        onNote={(note) => step((x) => ({ ...x, note }))}
        onWay={(way) => step((x) => withWay(x, way))}
        onRadius={(radius) => step((x) => ({ ...x, radius }))}
        onBand={(band) => step((x) => ({ ...x, band }))}
        onPaste={(paste) => step((x) => withPaste(x, paste))}
        onSave={() => void save()}
        onDiscard={discard}
      />
    );

  return {
    draft,
    task,
    startNew: () => setDraft(startFeatureDraft()),
    redraw: (featureId) => {
      const row = rows?.find((r) => r._id === featureId);
      if (row === undefined) return;
      setDraft(startRedrawDraft(redrawTarget(row)));
    },
  };
}
