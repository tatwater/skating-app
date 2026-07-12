/**
 * Typed geospatial indexes (D5), backed by the `@convex-dev/geospatial` component.
 *
 * The component maps a unique string key → a point on the Earth, with efficient
 * "what's inside this rectangle / nearest to this point" queries (S2 cells). We key
 * each index by the owning document's `_id`, so a query result hydrates back to the
 * real row with a single `ctx.db.get`.
 *
 * `filterKeys` are indexed alongside the point for server-side prefiltering — we index the
 * derived boolean `listed` (D48/D5) so a public viewport query can ask the component for
 * on-the-map bodies only (`listed == true`), rather than fetching hidden ones and dropping
 * them afterward. `listed` replaces the Phase-0 `reviewStatus`-only key, which would have
 * hidden every canonical (OSM/NHD) body — they carry no `reviewStatus` — and every
 * auto-visible `pending` user body (D37). Derived by `isListed` (see `./listing`).
 */

import { GeospatialIndex } from '@convex-dev/geospatial'
import { components } from '../_generated/api'
import type { Id } from '../_generated/dataModel'

/**
 * Water bodies indexed by `centroid`, keyed by the `waterBodies` doc id, filtered by the
 * derived `listed` boolean (D48). The component accepts boolean filter values directly.
 *
 * `components.geospatial` is runtime-correct, but our offline `_generated/api` types
 * `components` as the loose `AnyComponents` stub (see `scripts/codegen.mjs`), so it
 * reads as possibly-undefined here — `npx convex dev` would type it as the concrete
 * `ComponentApi`. Assert the constructor's own param type to bridge that gap.
 */
export const waterBodiesGeo = new GeospatialIndex<Id<'waterBodies'>, { listed: boolean }>(
  components.geospatial as unknown as ConstructorParameters<typeof GeospatialIndex>[0],
)
