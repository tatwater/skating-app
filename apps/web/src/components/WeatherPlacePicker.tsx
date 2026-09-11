import { useNavigate } from '@tanstack/react-router';

/**
 * Which place on a giant the Planning tab's weather is about (N6h / open question 5).
 *
 * Renders nothing on the ~99% of bodies with no named bays: their weather is about the lake and
 * there is nothing to pick. On a body with bays it is the panel's scope line **and** the switcher —
 * *"Weather at [Malletts Bay ▾]"* — so the reader learns the reading is for a named place and how
 * to change it from one element.
 *
 * ⚠ Picking a bay is a **navigation**, not local state. It writes the route's `?sub=`, the same
 * param a search hit sets, so the camera frames the bay, the report feed's filter seeds to it and
 * this panel reads its cell — one selection concept across the drawer rather than a third one
 * (founder call, 2026-09-11). The *default* bay, by contrast, is never written back: opening a lake
 * must not be a navigation, so `resolveWeatherSubArea` picks it implicitly and the URL stays clean
 * until the reader chooses.
 */
export function WeatherPlacePicker({
  waterBodyId,
  bays,
  selectedId,
}: {
  waterBodyId: string;
  /** Live bays only, in display order. */
  bays: readonly { _id: string; name: string }[];
  /** The bay the panel is currently about — explicit or implicit. */
  selectedId: string | null;
}) {
  const navigate = useNavigate();
  if (bays.length === 0 || selectedId === null) return null;
  if (bays.length === 1) {
    return (
      <p className="text-foreground-muted text-xs">
        Weather at <span className="text-foreground">{bays[0]?.name}</span>
      </p>
    );
  }
  return (
    <label className="flex items-center gap-2 text-foreground-muted text-xs">
      <span>Weather at</span>
      <select
        className="rounded-md border border-border bg-surface px-2 py-1 text-foreground"
        value={selectedId}
        onChange={(e) =>
          navigate({
            to: '/water/$id',
            params: { id: waterBodyId },
            search: { sub: e.target.value },
          })
        }
        aria-label="Which part of the lake the weather is for"
      >
        {bays.map((bay) => (
          <option key={bay._id} value={bay._id}>
            {bay.name}
          </option>
        ))}
      </select>
    </label>
  );
}
