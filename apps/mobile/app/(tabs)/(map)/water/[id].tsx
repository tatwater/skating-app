import { useLocalSearchParams } from 'expo-router';
import { WaterBodyDetail } from '../../../../src/components/WaterBodyDetail';

// `/water/[id]` — a deep-linkable water-body detail drawer over the map (D47). Rendered into the
// `(map)` layout's bottom-sheet `<Slot />`.
//
// `?track=` carries the local id of a just-finished recording (Phase 8), so "Report this skate"
// lands here with the form already open and the track attached.
//
// `?activity=` carries the **server** id of an already-synced skate (N6f), which is what the You
// tab's unreported-skates list has to offer — a track recorded on another device, or one whose local
// draft has long since flushed, has no local id left to pass.
//
// `?sub=` carries a named bay picked from search (N2/D60). A bay has no page of its own — it opens
// its parent's — and this is what frames the map on the bay instead of on the whole lake.
export default function WaterRoute() {
  const { id, track, activity, sub } = useLocalSearchParams<{
    id: string;
    track?: string;
    activity?: string;
    sub?: string;
  }>();
  return (
    <WaterBodyDetail
      waterBodyId={id}
      {...(track ? { trackDraftId: track } : {})}
      {...(activity ? { activityId: activity } : {})}
      {...(sub ? { focusSubAreaId: sub } : {})}
    />
  );
}
