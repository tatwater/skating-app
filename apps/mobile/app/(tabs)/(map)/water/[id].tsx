import { useLocalSearchParams } from 'expo-router';
import { WaterBodyDetail } from '../../../../src/components/WaterBodyDetail';

// `/water/[id]` — a deep-linkable water-body detail drawer over the map (D47). Rendered into the
// `(map)` layout's bottom-sheet `<Slot />`.
//
// `?track=` carries the local id of a just-finished recording (Phase 8), so "Report this skate"
// lands here with the form already open and the track attached.
export default function WaterRoute() {
  const { id, track } = useLocalSearchParams<{ id: string; track?: string }>();
  return <WaterBodyDetail waterBodyId={id} {...(track ? { trackDraftId: track } : {})} />;
}
