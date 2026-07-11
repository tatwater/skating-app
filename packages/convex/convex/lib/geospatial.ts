/**
 * Typed geospatial indexes (D5), backed by the `@convex-dev/geospatial` component.
 *
 * The component maps a unique string key → a point on the Earth, with efficient
 * "what's inside this rectangle / nearest to this point" queries (S2 cells). We key
 * each index by the owning document's `_id`, so a query result hydrates back to the
 * real row with a single `ctx.db.get`.
 *
 * `filterKeys` are indexed alongside the point for server-side prefiltering — we index
 * `reviewStatus` so a public viewport query can ask the component for *approved* bodies
 * only, rather than fetching pending ones and dropping them afterward (D37).
 */

import { GeospatialIndex } from '@convex-dev/geospatial'
import type { REVIEW_STATUSES } from './enums'
import { components } from '../_generated/api'
import type { Id } from '../_generated/dataModel'

type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/**
 * Water bodies indexed by `centroid`, keyed by the `waterBodies` doc id.
 *
 * `components.geospatial` is runtime-correct, but our offline `_generated/api` types
 * `components` as the loose `AnyComponents` stub (see `scripts/codegen.mjs`), so it
 * reads as possibly-undefined here — `npx convex dev` would type it as the concrete
 * `ComponentApi`. Assert the constructor's own param type to bridge that gap.
 */
export const waterBodiesGeo = new GeospatialIndex<
  Id<'waterBodies'>,
  { reviewStatus: ReviewStatus }
>(components.geospatial as unknown as ConstructorParameters<typeof GeospatialIndex>[0])
