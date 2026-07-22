import { useLocalSearchParams } from 'expo-router';
import { HazardDetail } from '../../../../src/components/HazardDetail';

/**
 * `/hazard/[id]` — the hazard drawer over the map, and the target of the
 * `skating://hazard/<id>` deep link (D54).
 *
 * The deep link is built now even though nothing sends one yet: Layer 2's notification tap needs
 * somewhere to land, and giving it a real destination today costs nothing while retrofitting a route
 * later would mean shipping a notification that opens the wrong screen.
 */
export default function HazardRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <HazardDetail hazardId={id} />;
}
