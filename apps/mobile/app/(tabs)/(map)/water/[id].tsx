import { Redirect, useLocalSearchParams } from 'expo-router';
import { WaterBodyDetail } from '../../../../src/components/WaterBodyDetail';
import { doorHref } from '../../../../src/lib/sheetDoors';

// `/water/[id]` — a deep-linkable water-body detail drawer over the map (D47). Rendered into the
// `(map)` layout's bottom-sheet `<Slot />`.
//
// `?sub=` carries a named bay picked from search (A02/D60). A bay has no page of its own — it opens
// its parent's — and this is what frames the map on the bay instead of on the whole lake.
//
// `?hazard=<stamp>` is the report sheet's *mark one here* (A10 §6.1): the drawer opens the hazard
// capture for this lake and the capture returns to the sheet. A stamp rather than a flag because
// the drawer stays mounted under the map tab: the second *mark one here* on the same lake is the
// same route, and only a new value tells the detail it is a new ask.
//
// `?track=` / `?activity=` were the pre-sheet doors for a finished recording and an unreported
// skate, which opened the form inside this drawer; they now land on the sheet (A10-3), so an old
// notification or link still works.
export default function WaterRoute() {
  const { id, track, activity, sub, hazard } = useLocalSearchParams<{
    id: string;
    track?: string;
    activity?: string;
    sub?: string;
    hazard?: string;
  }>();
  if (track || activity) {
    return (
      <Redirect
        href={doorHref({
          body: id,
          ...(track ? { track } : {}),
          ...(activity ? { activity } : {}),
        })}
      />
    );
  }
  return (
    <WaterBodyDetail
      waterBodyId={id}
      {...(sub ? { focusSubAreaId: sub } : {})}
      {...(hazard ? { captureHazard: hazard } : {})}
    />
  );
}
