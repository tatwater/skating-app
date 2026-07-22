import { useLocalSearchParams } from 'expo-router';
import { ReportDetail } from '../../../../src/components/ReportDetail';

// `/report/[id]` — a deep-linkable report detail drawer over the map (D42/D47). Rendered into the
// `(map)` layout's bottom-sheet `<Slot />`.
export default function ReportRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ReportDetail reportId={id} />;
}
