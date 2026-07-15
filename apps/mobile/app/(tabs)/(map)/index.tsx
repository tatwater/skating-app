/**
 * The bare Map route (§F). The map itself lives in the `(map)` layout (persistent across the detail
 * routes), so this route renders no content — it simply represents "drawer closed" (see the layout's
 * `isDetail`). Tapping a lake navigates to `/water/[id]`, which opens the drawer over this same map.
 */
export default function MapScreen() {
  return null
}
