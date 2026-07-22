import { useLocalSearchParams } from 'expo-router';
import { HazardDetail } from '../../../../src/components/HazardDetail';

/**
 * `/hazard/[id]` — the hazard drawer over the map, and the target of the
 * `skating://hazard/<id>` deep link (D54).
 *
 * The on-ice notification tap lands here as `skating://hazard/<id>?action=confirm` (D54 Layer 2);
 * `action=confirm` scrolls the confirm control into view so the tap opens pre-focused on it.
 */
export default function HazardRoute() {
  const { id, action } = useLocalSearchParams<{ id: string; action?: string }>();
  return <HazardDetail hazardId={id} action={action === 'confirm' ? 'confirm' : undefined} />;
}
