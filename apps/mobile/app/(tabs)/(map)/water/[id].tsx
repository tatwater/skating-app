import { useLocalSearchParams } from 'expo-router';
import { WaterBodyDetail } from '../../../../src/components/WaterBodyDetail';

// `/water/[id]` — a deep-linkable water-body detail drawer over the map (D47). Rendered into the
// `(map)` layout's bottom-sheet `<Slot />`.
export default function WaterRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <WaterBodyDetail waterBodyId={id} />;
}
