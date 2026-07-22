import { useLocalSearchParams } from 'expo-router';
import { BountyDetail } from '../../../../src/components/BountyDetail';

// `/bounty/[id]` — a deep-linkable bounty detail drawer over the map (D47). Rendered into the `(map)`
// layout's bottom-sheet `<Slot />`, mirroring `report/[id]` and `hazard/[id]`.
export default function BountyRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <BountyDetail bountyId={id} />;
}
