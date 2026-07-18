/**
 * Convex app definition — registers installed components (D5).
 *
 * `@convex-dev/geospatial` is a Convex *component*: a sandboxed sub-deployment with
 * its own tables/functions that we call through the generated `components.geospatial`
 * handle. Registering it here is what makes that handle exist. The component indexes
 * water-body centroids / report points for viewport (bbox) and nearest lookups; see
 * `lib/geospatial.ts` for the typed client.
 *
 * We install it **twice** (D5 / Phase 5): the default instance indexes `waterBodies`
 * centroids; a second, named `adminAreasGeo` instance indexes `adminAreas` boundary
 * centroids for point→place resolution. Separate instances keep the two keyspaces (and
 * their per-query read caps) fully isolated rather than sharing one point index.
 */

import geospatial from '@convex-dev/geospatial/convex.config'
import { defineApp } from 'convex/server'

const app = defineApp()
app.use(geospatial)
app.use(geospatial, { name: 'adminAreasGeo' })

export default app
