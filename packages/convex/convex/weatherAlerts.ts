/**
 * NWS active alerts — poll, cache, and serve per body (N6c Workstream B5, D74).
 *
 * **Polled per state on a cron, never per body per view.** Alerts are issued over counties and
 * forecast zones, so one state-level fetch serves every body in that state and the read cost stays
 * independent of corpus size. This is the `listInViewport` lesson applied before it can bite: the
 * per-body-per-view shape would be 24,953 potential fetches behind a map pan.
 *
 * **This never feeds a calculation (D74).** The decay math, the bounty gate and the contradiction
 * settle all read Open-Meteo and only Open-Meteo. Blending a second provider into any of them would
 * produce a worse number, not a better one, and would break the reproducibility the whole D56 model
 * rests on. Nothing here is imported by those paths.
 */

import {
  alertsForBody,
  isSkatingRelevantAlert,
  KNOWN_STATE_CODES,
  type NwsAlert,
  zoneIdFromUri,
} from '@skating/core';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalMutation, internalQuery, query } from './_generated/server';

const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';

/**
 * NWS requires a `User-Agent` identifying the application, and their docs ask for a contact address
 * in it so they can reach an operator whose client misbehaves. A generic agent is grounds for being
 * blocked, and the block would look exactly like the API being down.
 *
 * Their rate limits are unpublished; a 429 is retried once after a short pause. Their documentation
 * warns an API key may be required in future — worth knowing here rather than discovering it as an
 * outage.
 */
const NWS_USER_AGENT = '(wildice.app, support@wildice.app)';

/** How long an alert row survives without being seen in a poll before the sweep drops it. */
const ALERT_STALE_MS = 6 * 60 * 60 * 1000;

/** NWS's GeoJSON alert feature, narrowed to what we read. */
interface NwsFeature {
  properties?: {
    id?: string;
    event?: string;
    headline?: string;
    severity?: string;
    areaDesc?: string;
    onset?: string;
    ends?: string;
    expires?: string;
    affectedZones?: string[];
    geocode?: { SAME?: string[]; UGC?: string[] };
  };
}

function parseMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Map one NWS feature to our shape, or `null` when it is unusable.
 *
 * **Both id spaces are collected** — `affectedZones` (forecast zones, `VTZ001`) and `geocode.UGC` /
 * `geocode.SAME` (counties) — because some products are issued by county rather than by zone.
 * Handling only one silently misses a class of alerts, and a missing warning is indistinguishable
 * from no warning.
 */
export function alertFromFeature(feature: NwsFeature, state: string): NwsAlert | null {
  const p = feature.properties;
  if (!p?.id || !p.event) return null;

  const zones = new Set<string>();
  for (const uri of p.affectedZones ?? []) {
    const id = zoneIdFromUri(uri);
    if (id) zones.add(id);
  }
  for (const ugc of p.geocode?.UGC ?? []) zones.add(ugc);
  for (const same of p.geocode?.SAME ?? []) zones.add(same);

  const alert: NwsAlert = {
    id: p.id,
    event: p.event,
    severity: p.severity ?? 'Unknown',
    zones: [...zones],
    states: [state],
  };
  if (p.headline) alert.headline = p.headline;
  if (p.areaDesc) alert.areaDesc = p.areaDesc;
  const onsetMs = parseMs(p.onset);
  if (onsetMs !== undefined) alert.onsetMs = onsetMs;
  const endsMs = parseMs(p.ends ?? p.expires);
  if (endsMs !== undefined) alert.endsMs = endsMs;
  return alert;
}

/** Fetch and parse one state's active alerts. Returns `null` on failure so the state is skipped. */
async function fetchStateAlerts(state: string): Promise<NwsAlert[] | null> {
  const url = `${NWS_ALERTS_URL}?area=${encodeURIComponent(state)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': NWS_USER_AGENT, Accept: 'application/geo+json' },
      });
      if (res.status === 429) {
        // Their limits are unpublished; a short pause and one retry is the documented courtesy.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }
      if (!res.ok) {
        console.warn(`NWS alerts for ${state} failed: ${res.status}`);
        return null;
      }
      const json = (await res.json()) as { features?: NwsFeature[] };
      const out: NwsAlert[] = [];
      for (const feature of json.features ?? []) {
        const alert = alertFromFeature(feature, state);
        // Filtered here rather than at render so the table stays small and the drawer stays dumb.
        if (alert && isSkatingRelevantAlert(alert)) out.push(alert);
      }
      return out;
    } catch (err) {
      console.warn(`NWS alerts for ${state} threw`, err);
      return null;
    }
  }
  return null;
}

/**
 * Replace the cached alert set for the states that answered.
 *
 * **Per state, not wholesale.** A poll where Vermont answered and Maine timed out must not clear
 * Maine's warnings — that would turn one provider blip into every Maine skater seeing no advisory at
 * all, which is the failure direction this feature exists to avoid. States that failed keep whatever
 * they had until they answer again or the staleness sweep retires it.
 */
export const replaceStateAlerts = internalMutation({
  args: {
    state: v.string(),
    alerts: v.array(
      v.object({
        id: v.string(),
        event: v.string(),
        headline: v.optional(v.string()),
        severity: v.string(),
        areaDesc: v.optional(v.string()),
        onsetMs: v.optional(v.number()),
        endsMs: v.optional(v.number()),
        zones: v.array(v.string()),
        states: v.array(v.string()),
      }),
    ),
    fetchedAt: v.number(),
  },
  handler: async (ctx, { state, alerts, fetchedAt }) => {
    const existing = await ctx.db
      .query('weatherAlerts')
      .withIndex('by_state', (q) => q.eq('state', state))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    for (const alert of alerts) {
      // **Field by field, not a spread.** `NwsAlert.id` is NWS's id and the column is `alertId`, so
      // `{ ...alert, alertId: alert.id }` carries a stray `id` the table has never declared — which
      // Convex rejects outright, and which would otherwise have been a silent extra field on a
      // schema that tolerated it.
      await ctx.db.insert('weatherAlerts', {
        state,
        alertId: alert.id,
        event: alert.event,
        ...(alert.headline !== undefined ? { headline: alert.headline } : {}),
        severity: alert.severity,
        ...(alert.areaDesc !== undefined ? { areaDesc: alert.areaDesc } : {}),
        ...(alert.onsetMs !== undefined ? { onsetMs: alert.onsetMs } : {}),
        ...(alert.endsMs !== undefined ? { endsMs: alert.endsMs } : {}),
        zones: alert.zones,
        states: alert.states,
        fetchedAt,
      });
    }
    return alerts.length;
  },
});

/** Drop alert rows no poll has refreshed in a long while — a state that has gone quiet or broken. */
export const sweepStaleAlerts = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - ALERT_STALE_MS;
    const stale = await ctx.db
      .query('weatherAlerts')
      .withIndex('by_fetched_at', (q) => q.lt('fetchedAt', cutoff))
      .take(500);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});

/** The cron entry point: poll every covered state, replace each independently. */
export const refreshAlerts = internalAction({
  args: {},
  handler: async (ctx) => {
    const fetchedAt = Date.now();
    let refreshed = 0;
    for (const state of KNOWN_STATE_CODES) {
      const alerts = await fetchStateAlerts(state);
      if (alerts === null) continue; // see `replaceStateAlerts` — a blip must not clear a state
      await ctx.runMutation(internal.weatherAlerts.replaceStateAlerts, {
        state,
        alerts,
        fetchedAt,
      });
      refreshed++;
    }
    await ctx.runMutation(internal.weatherAlerts.sweepStaleAlerts, {});
    return { statesRefreshed: refreshed };
  },
});

/** Every cached alert. Bounded by design — five states of active winter products is tens of rows. */
export const listAll = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query('weatherAlerts').take(500),
});

/**
 * Public: the alerts covering a body, most severe first.
 *
 * A plain query with no fetch in it — the cron owns the network, so a drawer-open costs one bounded
 * table read regardless of how many skaters open the same lake at once.
 */
export const listForBody = query({
  args: { waterBodyId: v.id('waterBodies') },
  handler: async (ctx, { waterBodyId }) => {
    const body = await ctx.db.get(waterBodyId);
    if (!body || body.removedAt) return [];
    const rows = await ctx.db.query('weatherAlerts').take(500);
    const alerts: NwsAlert[] = rows.map((row) => {
      const alert: NwsAlert = {
        id: row.alertId,
        event: row.event,
        severity: row.severity,
        zones: row.zones,
        states: row.states,
        // Carried so `alertsForBody` can prefer the freshest copy of a multi-state alert — after a
        // partial poll failure the per-state rows diverge, and without this the matcher cannot tell
        // which one NWS updated most recently.
        fetchedAt: row.fetchedAt,
      };
      if (row.headline) alert.headline = row.headline;
      if (row.areaDesc) alert.areaDesc = row.areaDesc;
      if (row.onsetMs !== undefined) alert.onsetMs = row.onsetMs;
      if (row.endsMs !== undefined) alert.endsMs = row.endsMs;
      return alert;
    });
    // The matcher lives in core so both clients and any future consumer share one ladder. Rung 1
    // (`nwsZoneIds`) is not stamped on any body yet, so every match falls to the state rung — which
    // is exactly what the ladder's fallback is for, and why a slipping zone import cannot block this.
    return alertsForBody({ states: body.states ?? [] }, alerts);
  },
});
