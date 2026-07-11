/**
 * Convex app definition — registers installed components (D5).
 *
 * `@convex-dev/geospatial` is a Convex *component*: a sandboxed sub-deployment with
 * its own tables/functions that we call through the generated `components.geospatial`
 * handle. Registering it here is what makes that handle exist. The component indexes
 * water-body centroids / report points for viewport (bbox) and nearest lookups; see
 * `lib/geospatial.ts` for the typed client.
 */

import { defineApp } from 'convex/server'
import geospatial from '@convex-dev/geospatial/convex.config'

const app = defineApp()
app.use(geospatial)

export default app
