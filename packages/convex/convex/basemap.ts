/**
 * Basemap hosting (Phase 1, PR#5 — D6). The self-built Vermont `.pmtiles` vector basemap is
 * stored in **Convex file storage**, colocated with the app: its serving URL honors HTTP
 * `Range` requests *and* reflects CORS, the two hard requirements for the browser `pmtiles://`
 * protocol (both verified before choosing this host).
 *
 * These are the **ops path** for uploading a rebuilt basemap — `internalMutation`s, never
 * client-callable, invoked by `scripts/basemap` via the Convex CLI with the deployment's admin
 * creds. See that directory's README for the build → upload → wire steps. The resulting serving
 * URL goes into `VITE_PMTILES_URL` (per environment).
 *
 * **Cost / scale note.** Convex bills file-storage egress, but `pmtiles://` range-reads only the
 * viewed tiles per map view (KBs), so pilot bandwidth is negligible and the ~280 MB Vermont
 * file sits well under the free-tier storage cap. If per-tile egress grows as regions expand,
 * Cloudflare R2 (zero egress) is the documented scale-out host — swapping is a `VITE_PMTILES_URL`
 * change, nothing here (see `plans/phase-1-water-bodies.md` open items + `04-integrations.md`).
 */

import { v } from 'convex/values'
import { internalMutation } from './_generated/server'

/** Mint a one-time upload URL; the operator POSTs the `.pmtiles` bytes to it (see the README). */
export const generateUploadUrl = internalMutation({
  args: {},
  handler: (ctx) => ctx.storage.generateUploadUrl(),
})

/**
 * Resolve an uploaded file's stable public serving URL from the `storageId` the upload POST
 * returns — this is the value pasted into `VITE_PMTILES_URL`. Returns `null` if the id is
 * unknown (deleted/never-stored).
 */
export const getServingUrl = internalMutation({
  args: { storageId: v.id('_storage') },
  handler: (ctx, { storageId }) => ctx.storage.getUrl(storageId),
})
