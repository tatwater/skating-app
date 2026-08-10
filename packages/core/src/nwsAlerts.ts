/**
 * NWS active alerts — the advisory layer (N6c Workstream B5, D74).
 *
 * `api.weather.gov` is free, needs no key, and is US-only. It does **not** replace Open-Meteo:
 * Open-Meteo's `past_days` history is the input to the D56 decay math and NWS has no comparable
 * history endpoint. What NWS uniquely has is **official alerts** — winter storm warnings, ice storm
 * warnings, wind chill advisories — issued by the local forecast office.
 *
 * > **D74 — one weather physics source, plus a separate advisory layer.**
 * > Open-Meteo stays the single source for anything that feeds a calculation. **Do not blend.** Two
 * > providers disagreeing produces a *worse* number, not a better one, and it would silently break
 * > the reproducibility of the decay math. NWS alerts render as a clearly-labelled advisory strip
 * > that **never feeds a calculation.**
 *
 * Nothing in this module is imported by the decay, bounty or contradiction paths, and there is no
 * numeric output here to tempt one — the whole surface is text, a severity ordering and a matcher.
 *
 * ## The zone ladder
 *
 * Alerts are matched to bodies by a two-rung ladder, exactly like N6a's depth sources:
 *
 * | Rung | Basis | When it applies |
 * |---|---|---|
 * | 1 | **Zone** — body stamped with its NWS forecast zone at ETL | whenever the stamp exists |
 * | 2 | **State** — via the existing `states[]` field | any body the zone import missed |
 *
 * **Rung 2 ships first and rung 1 is not built yet**, which is deliberate rather than incomplete: a
 * slipping zone import cannot block the feature, it just means some bodies over-show for a while.
 * Over-showing is the safe direction — a skater who sees a warning for the next valley loses
 * nothing, and a skater who misses one for their own loses a great deal.
 */

/** The alert fields we keep. A superset of what renders, so the drawer can change its mind cheaply. */
export interface NwsAlert {
  /** NWS's own alert id (`properties.id`) — stable, and what dedupes a re-poll. */
  id: string;
  /** e.g. "Winter Storm Warning". `properties.event`. */
  event: string;
  /** A one-line human summary. `properties.headline`, which may be absent on some products. */
  headline?: string;
  /** `Extreme` | `Severe` | `Moderate` | `Minor` | `Unknown` — NWS's own vocabulary, unmapped. */
  severity: string;
  /** Human description of the affected area ("Northern Vermont"). `properties.areaDesc`. */
  areaDesc?: string;
  /** Epoch ms. Absent when NWS omits them, which happens on some long-running products. */
  onsetMs?: number;
  endsMs?: number;
  /**
   * Zone and county ids this alert covers, normalized from `properties.affectedZones` URIs and
   * `properties.geocode`. **Both id spaces, because they are genuinely different ones** — most
   * products are issued over forecast zones (`VTZ001`) but some are issued by county (SAME/FIPS),
   * and handling only one silently misses a whole class of alerts. The failure mode is invisible: a
   * missing warning looks exactly like no warning.
   */
  zones: string[];
  /** The 2-letter states this alert was polled under. Rung 2's matcher. */
  states: string[];
  /**
   * `properties.sent` — when **NWS issued this version** of the alert.
   *
   * The authoritative answer to "which of these two copies is newer", because it is a property of
   * the message rather than of our polling. An update to a warning is a re-issue with a later
   * `sent`; two copies sharing a `sent` are the same version and are interchangeable.
   */
  sentMs?: number;
  /**
   * When the row carrying this copy was last polled.
   *
   * **Present only on alerts read back from the cache**, which is why it is optional —
   * `alertFromFeature` builds an alert before anything has stored it. It exists so
   * {@link alertsForBody} can pick the *freshest* copy when the same alert arrives more than once;
   * see the dedupe there for why that is not a tie-break detail.
   */
  fetchedAt?: number;
}

/**
 * NWS severity, most severe first, for ordering a body's alerts.
 *
 * Unknown values sort last rather than throwing: NWS may add a level, and an alert we cannot rank is
 * still an alert we must show.
 */
export const NWS_SEVERITY_ORDER = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'] as const;

/** Rank for sorting. Higher is more severe. */
export function nwsSeverityRank(severity: string): number {
  const index = NWS_SEVERITY_ORDER.indexOf(severity as (typeof NWS_SEVERITY_ORDER)[number]);
  return index === -1 ? -1 : NWS_SEVERITY_ORDER.length - index;
}

/**
 * Alert `event` substrings worth showing a skater.
 *
 * **A filter, and an argued one.** NWS issues plenty that has nothing to do with ice — a Red Flag
 * Warning, an Air Quality Alert, a Rip Current Statement — and rendering all of it on a lake page
 * would train people to ignore the strip, which is the one outcome that makes a safety surface
 * useless. What survives is weather that changes ice or changes whether you can stand on it.
 *
 * Matched case-insensitively as substrings, because NWS's event vocabulary is long, regional and
 * occasionally revised; an exact-match list would silently drop a renamed product.
 */
export const SKATING_RELEVANT_ALERT_TERMS = [
  'winter',
  'ice',
  'snow',
  'blizzard',
  'freez',
  'frost',
  'cold',
  'wind chill',
  'high wind',
  'flood',
  'lakeshore',
] as const;

/** Whether an alert's event is one a skater should see. */
export function isSkatingRelevantAlert(alert: { event: string }): boolean {
  const event = alert.event.toLowerCase();
  return SKATING_RELEVANT_ALERT_TERMS.some((term) => event.includes(term));
}

/** The subset of a body the alert matcher reads. */
export interface AlertMatchBody {
  states?: string[];
  /** Rung 1, once the zone import lands. Absent everywhere today. */
  nwsZoneIds?: string[];
}

/**
 * The alerts that apply to a body, most severe first.
 *
 * **Rung 1 wins outright when the body carries zone stamps** — it does not merge with the state
 * rung. A body with a zone knows precisely which alerts cover it, and adding the whole state's
 * alerts back on top would throw that precision away while looking like it had been used. A body
 * with no stamp falls to the state rung whole.
 */
export function alertsForBody(body: AlertMatchBody, alerts: readonly NwsAlert[]): NwsAlert[] {
  const zones = body.nwsZoneIds;
  const matched =
    zones && zones.length > 0
      ? alerts.filter((a) => a.zones.some((z) => zones.includes(z)))
      : alerts.filter((a) => a.states.some((s) => body.states?.includes(s)));

  // **Deduplicate on NWS's own alert id, keeping the FRESHEST copy.**
  //
  // The cache stores **one row per (state, alert)** because the poll is per state and a state has to
  // be replaceable on its own (a Vermont poll must not clear Maine's warnings). So a single winter
  // storm warning covering Vermont *and* New Hampshire is stored twice under one `alertId`, and every
  // border-spanning body matches both — including Lake Champlain, the most prominent body in the
  // corpus. Without deduping, one warning renders as two.
  //
  // **Freshest rather than first, because "first" is reliably the stale one.** The two copies are
  // identical only while both states are polling successfully. After a partial failure they diverge:
  // Vermont refreshes to NWS's current text while New Hampshire keeps the copy it had, so severity,
  // `endsMs` and the headline can all be a version behind. And `replaceStateAlerts` deletes and
  // re-inserts, so a *refreshed* row has a newer `_creationTime` and sorts **later** than the stale
  // one it should beat — first-wins would pick the stale copy as the default case, not the edge case.
  //
  // An absent `fetchedAt` loses to any timestamp and ties keep the earlier element, so the order is
  // total and stable either way.
  const freshest = new Map<string, NwsAlert>();
  for (const a of matched) {
    const held = freshest.get(a.id);
    if (!held || compareAlertVersion(a, held) > 0) freshest.set(a.id, a);
  }

  return [...freshest.values()].sort((a, b) => {
    const bySeverity = nwsSeverityRank(b.severity) - nwsSeverityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    // Stable tie-break so the list does not shuffle between renders.
    return a.id.localeCompare(b.id);
  });
}

/**
 * Order two copies of the same alert by how recent they are. Positive when `a` is newer.
 *
 * **Tiered, because `sent` and `fetchedAt` are different clocks and must not be compared to each
 * other.** Both are epoch milliseconds, so collapsing them into one scalar type-checks and quietly
 * does the wrong thing: a fetch time is always *later* than the issue time of the version it
 * retrieved, so a copy we can only date by our own clock would out-rank one NWS actually
 * version-stamped. (Caught by a test written against the scalar version of this function.)
 *
 * So: a copy carrying NWS's `sent` outranks one that doesn't, and only then do like clocks compare.
 *
 * **Why `sent` leads at all.** `refreshAlerts` polls five states **sequentially**, and a 429 costs a
 * 5 s pause, so two states' copies of one alert are retrieved seconds to minutes apart — long enough
 * for NWS to re-issue in between. Fetch time answers "when did we ask", which is a fact about our
 * cron; `sent` answers "which version is this", which is a fact about the alert.
 */
export function compareAlertVersion(a: NwsAlert, b: NwsAlert): number {
  const aStamped = a.sentMs !== undefined;
  const bStamped = b.sentMs !== undefined;
  if (aStamped !== bStamped) return aStamped ? 1 : -1;
  if (aStamped && bStamped) {
    const bySent = (a.sentMs as number) - (b.sentMs as number);
    if (bySent !== 0) return bySent;
  }
  // Same version (or neither stamped) — fall back to which copy we refreshed most recently.
  return (a.fetchedAt ?? 0) - (b.fetchedAt ?? 0);
}

/** Normalize an `affectedZones` URI (".../zones/forecast/VTZ001") to its bare id. */
export function zoneIdFromUri(uri: string): string | null {
  const last = uri.split('/').pop();
  return last && last.length > 0 ? last : null;
}

/** The line the advisory strip renders for one alert. Event plus area, never our own words. */
export function formatAlertLine(alert: NwsAlert): string {
  return alert.areaDesc ? `${alert.event} — ${alert.areaDesc}` : alert.event;
}
