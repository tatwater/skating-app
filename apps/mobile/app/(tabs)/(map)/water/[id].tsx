import { useLocalSearchParams } from 'expo-router';
import { WaterBodyDetail } from '../../../../src/components/WaterBodyDetail';

// `/water/[id]` — a deep-linkable water-body detail drawer over the map (D47). Rendered into the
// `(map)` layout's bottom-sheet `<Slot />`.
//
// `?track=` carries the local id of a just-finished recording (Phase 8), so "Report this skate"
// lands here with the form already open and the track attached.
//
// `?sub=` carries a named bay picked from search (N2/D60). A bay has no page of its own — it opens
// its parent's — and this is what frames the map on the bay instead of on the whole lake.
export default function WaterRoute() {
  const { id, track, sub } = useLocalSearchParams<{ id: string; track?: string; sub?: string }>();
  return (
    <WaterBodyDetail
      waterBodyId={id}
      {...(track ? { trackDraftId: track } : {})}
      {...(sub ? { focusSubAreaId: sub } : {})}
    />
  );
}
