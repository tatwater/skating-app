/**
 * Typed geospatial indexes (D5), backed by the `@convex-dev/geospatial` component.
 *
 * The component maps a unique string key → a point on the Earth, with efficient
 * "what's inside this rectangle / nearest to this point" queries (S2 cells). We key
 * each index by the owning document's `_id`, so a query result hydrates back to the
 * real row with a single `ctx.db.get`.
 *
 * `filterKeys` are indexed alongside the point (the derived boolean `listed`, D48/D5, replacing
 * the Phase-0 `reviewStatus`-only key that would have hidden every canonical body — they carry no
 * `reviewStatus` — and every auto-visible `pending` user body, D37; derived by `isListed`, see
 * `./listing`). We keep the key indexed, but `listInViewport` **does not** filter on it in the
 * geospatial query: the component's filter-stream intersection roughly halves the read-cap-safe
 * `maxResults` ceiling, so a wide viewport crashes (Convex's 4,096-reads limit). Instead the
 * viewport query fetches by rectangle and re-checks `isListed` in JS — cheap in Phase 1 (~no
 * unlisted bodies). See the `listInViewport` tier-1 note for the full read-cap reasoning.
 *
 * The per-entry **`sortKey`** (the 5th `insert` arg) holds a body's **`minVisibleZoom`** (D49) —
 * NOT `createdAt`. The component supports a numeric `sortKey` range filter (`.gte`/`.lt`) and orders
 * results by it, so `listInViewport` filters `sortKey <= zoom` in-query and, if it ever caps, keeps
 * the *most prominent* bodies (lowest `minVisibleZoom`) instead of an arbitrary slice.
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
