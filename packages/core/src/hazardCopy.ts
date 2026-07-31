/**
 * Hazard copy (D3) — **the one place allowed to turn hazard state into words.**
 *
 * This module exists because the dangerous failure of a safety app is not a missing feature, it's a
 * reassuring sentence. Every other module produces state (`stale`, `fully_healed`, `goneCount >= 2`);
 * only this one produces language, so the rule "we never assert that ice is safe" is enforceable by
 * reading a single file instead of auditing every component.
 *
 * The three rules, all of which the research pass turned up real deaths behind:
 *
 * 1. **Decay is confidence, not safety.** An aging `open_water` pin does not mean the water closed. It
 *    means nobody has looked recently. A refrozen lead *is* thin ice, so the honest phrasing is
 *    "was open — may now be thinly skinned", never "clear".
 * 2. **"Healed" never means "safe".** A pressure ridge that heals becomes *ice sharks* — a line of
 *    refrozen blocks you can still catch an edge on. That's why `healing_unsafe` keeps the pin.
 * 3. **Silence is not an all-clear.** No alert means nothing was *reported* nearby. It is not a
 *    statement about the ice, and it is an especially weak one in v1, where the proximity watcher only
 *    runs while the app is foregrounded.
 *
 * Vocabulary is borrowed from lakeice.info (Bob Dill et al., research §7) because those terms are both
 * precise and inherently non-reassuring: *overnight ice*, *splash-out ice*, *ice sharks*, *meringue
 * ice*, *ice edge*, *rotten candled ice*, *loose-plate ridge*.
 */

import type { HazardFreshness } from './hazardDecay';
import type { HazardVerdict } from './hazardLifecycle';
import { HAZARD_TYPE_LABELS, type HazardType, isPassageMarker } from './types';

/** The human label for a hazard type — "Open water / lead", not `open_water`. */
export function hazardTypeLabel(type: HazardType): string {
  return HAZARD_TYPE_LABELS[type];
}

/**
 * How current the report is. Note that none of these say anything about the *ice* — they describe the
 * age of the observation, which is the only thing elapsed time actually tells us.
 */
export function freshnessLabel(freshness: HazardFreshness): string {
  switch (freshness) {
    case 'fresh':
      return 'Recently reported';
    case 'aging':
      return 'Not confirmed recently';
    case 'stale':
      return 'Old report — unverified';
  }
}

/**
 * What an aging or stale hazard most likely means *for this type* — the sentence that has to do the
 * work of not sounding like an all-clear.
 *
 * The types that "heal" are exactly the types whose healed state is still dangerous, so each one names
 * what it probably became rather than implying it went away.
 */
export function stalenessCaveat(type: HazardType): string {
  switch (type) {
    case 'open_water':
      return 'May have skinned over since — a refrozen lead is thin ice.';
    case 'thin_ice':
      return 'May have thickened or reopened since — thin new ice can weaken in under an hour.';
    case 'overflow_slush':
      return 'May have frozen into gray ice since, or may still be slush under a skin.';
    case 'drain_hole':
    case 'wind_hole':
    case 'slush_hole':
      return 'May have refrozen since — refrozen holes stay weaker than the ice around them.';
    case 'thawed_rotten':
      return 'Cold since then does not fix this. A thawed sheet grows a hard skin overnight and gives way as it warms.';
    case 'ridge_crossing':
      return 'Crossings change hour to hour — this may no longer be passable.';
    case 'wet_crack':
      return 'Working cracks reopen and close daily; may be wider or refrozen.';
    case 'drilled_hole':
      return 'Likely re-skinned, but a drilled hole stays a weak spot for days.';
    case 'shell_area':
      return 'Shell ice is hard to see and lingers days after the thaw that made it.';
    case 'pressure_ridge':
    case 'ice_heave':
      return 'Ridges do not heal within a season. A warm spell can open one into water; a cold one leaves refrozen blocks ("ice sharks").';
    case 'spring_current':
    case 'gas_hole':
    case 'reef_hole':
      return 'This is a permanent feature — weak every season regardless of how cold it has been.';
  }
}

/** The three-tier confirm control's button labels, relabeled for the passage marker (research §4). */
export function verdictLabel(verdict: HazardVerdict, type: HazardType): string {
  if (isPassageMarker(type)) {
    switch (verdict) {
      case 'still_there':
        return 'Still crossable';
      case 'healing_unsafe':
        return 'Crossing looks dicey now';
      case 'fully_healed':
        return 'Ridge closed / healed';
      case 'never_existed':
        return 'No crossing here';
    }
  }
  switch (verdict) {
    case 'still_there':
      return 'Still here';
    case 'healing_unsafe':
      return 'Healing — still unsafe';
    case 'fully_healed':
      return 'Fully healed & safe';
    case 'never_existed':
      return 'Nothing here — never was';
  }
}

/**
 * Helper text under each verdict button. The `fully_healed` line names the consequence out loud,
 * because it is the only destructive verdict and the asymmetry is deliberate: believing a hazard is
 * present when it isn't costs a detour, believing it's gone when it isn't can kill someone.
 *
 * **A passage marker inverts the meaning of every verdict, so it needs its own copy for all three.** On
 * a `ridge_crossing`, `fully_healed` means "the crossing is *gone*" (retire a now-useless marker), not
 * "the ice is sound". Falling through to the danger-hazard text — "only if the ice here is genuinely
 * sound" — is the D3 failure mode with the sign flipped: it would tell a skater standing at a closed
 * crossing not to retire it unless the ice is safe, leaving a stale "you can get across here" marker
 * pointing people at a passage that no longer exists.
 */
export function verdictHelp(verdict: HazardVerdict, type: HazardType): string {
  if (isPassageMarker(type)) {
    switch (verdict) {
      case 'still_there':
        return 'You got across here. Ridges change hour to hour — check it yourself before you rely on it.';
      case 'healing_unsafe':
        return 'The crossing has gotten worse. The marker stays up, now flagged as dicey.';
      case 'fully_healed':
        return 'The ridge has closed here — this is no longer a way across. Two of these retire the marker.';
      case 'never_existed':
        return 'There is no crossing at this spot and there never was — the marker is in the wrong place. A moderator is told.';
    }
  }
  switch (verdict) {
    case 'still_there':
      return 'You can see it. Resets the clock on this report.';
    case 'healing_unsafe':
      return 'It has changed but is still dangerous. The marker stays up so the next skater can read it.';
    case 'fully_healed':
      return 'Only if the ice here is genuinely sound. Two of these retire the marker for everyone.';
    case 'never_existed':
      return 'Not that it cleared — that there was never anything here. Use this for a pin in the wrong place, not for ice that changed. A moderator is told.';
  }
}

/**
 * The annotation on a **disputed** suggested crossing (D64) — one skater has said the ridge is closed
 * here, which is one vote short of retiring the marker.
 *
 * It never says the crossing is unusable, because one report isn't that; it says the thing a skater
 * standing at the ridge needs to know, which is that the last person to look disagreed with the pin.
 * Passage markers only: the same disclosure on a hazard would invite skaters to discount a live
 * warning, and one below-threshold "it's gone" vote must never do that.
 */
export function disputedNote(): string {
  return 'The safety of this crossing has been disputed — someone reported the ridge closed here. Judge it yourself before you rely on it.';
}

/** The annotation shown on a pin whose latest verdict was "healing but unsafe". */
export function healingNote(type: HazardType): string {
  if (type === 'pressure_ridge' || type === 'ice_heave') {
    return 'Reported healing — likely refrozen blocks ("ice sharks"). Still a fall hazard.';
  }
  return 'Reported healing, but still called unsafe by the last skater who looked.';
}

/**
 * "Confirmed by Alex R., Sam K. and 3 others" (D65).
 *
 * `named` are the confirmers whose profiles are public; `total` is everyone who said the pin is still
 * there, named or not. A private profile is **counted, never named** — the name follows the consent
 * the skater already gave, rather than a new one this feature invents — so the count is always the
 * honest number even when the list is short.
 *
 * Returns `null` when nobody has confirmed: "confirmed by nobody" is a sentence that reads as an
 * all-clear, and D3 forbids exactly that.
 *
 * No trailing full stop, unlike the rest of this file — a display name can perfectly well end in one
 * ("Alex R."), and "Alex R.." is the kind of detail that makes a safety surface look unmaintained.
 */
export function confirmerSummary(named: readonly string[], total: number): string | null {
  if (total <= 0) return null;
  const others = Math.max(0, total - named.length);
  const otherLabel = `${others} ${others === 1 ? 'other' : 'others'}`;
  if (named.length === 0) {
    return `Confirmed by ${total} ${total === 1 ? 'skater' : 'skaters'}`;
  }
  const parts = others > 0 ? [...named, otherLabel] : [...named];
  if (parts.length === 1) return `Confirmed by ${parts[0]}`;
  const last = parts[parts.length - 1];
  return `Confirmed by ${parts.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * The same summary as a **mid-sentence clause** — "reported 3 days ago by Alex · confirmed by Sam K.
 * and 2 others" — which is the only way either app actually uses it.
 *
 * It exists because the obvious way to write that call site is `confirmerSummary(...).toLowerCase()`,
 * and that is exactly wrong now that the string contains names: it renders *"confirmed by alex r. and
 * 3 others"*, quietly mangling the one thing D65 added. Lowering the leading word and nothing else is
 * a single-character edit that no call site should be trusted to remember, so it lives here with the
 * reason attached.
 */
export function confirmerClause(named: readonly string[], total: number): string | null {
  const summary = confirmerSummary(named, total);
  return summary === null ? null : summary.charAt(0).toLowerCase() + summary.slice(1);
}

/**
 * The note on a **suggested crossing that has aged out** (D64) — past its 72-hour window, so it has
 * already left the map and only a permalink can still reach it.
 *
 * Says the marker is old rather than that the crossing is closed, because nobody has reported either:
 * the whole point of passage-marker expiry is that *silence* retires the pin. The confirm buttons stay
 * offered under this note on purpose — a skater who just got across is precisely the evidence that
 * revives it.
 */
export function expiredCrossingNote(): string {
  return 'Nobody has reported getting across here in over three days, so this suggested crossing has aged off the map. It is not a report that the ridge has closed — just that nobody has looked. If you cross here, say so and it comes back.';
}

/** The on-ice soft prompt for an unconfirmed hazard. Its answer *is* the confirmation (D54). */
export function confirmRequestPrompt(type: HazardType): string {
  return `Someone flagged ${hazardTypeLabel(type).toLowerCase()} near here — can you see it?`;
}

/**
 * The on-ice warning for a confirmed hazard. Distance is approximate on purpose ("~120 m"): a precise
 * number would imply a precision neither the GPS nor the reported footprint has (D3).
 */
export function warningHeadline(type: HazardType, distanceMeters: number): string {
  const approx =
    distanceMeters < 25 ? 'right here' : `~${Math.round(distanceMeters / 10) * 10} m away`;
  return `${hazardTypeLabel(type)} reported ${approx}`;
}

/**
 * Shown wherever proximity alerting is surfaced or configured. Non-negotiable (D54 amendment): a
 * proximity system that has only ever been quiet is the most dangerous signal we could emit, and
 * foreground-only coverage makes that worse, not better.
 */
export const NO_ALERT_IS_NOT_ALL_CLEAR =
  'No alert does not mean the ice is safe — it only means nothing has been reported near you.';

/**
 * The standing caveat under any hazard footprint. Reinforces that the shape is an approximation drawn
 * by a person, not a surveyed boundary (D3/D51).
 */
export const FOOTPRINT_IS_APPROXIMATE =
  'Reported around here — the shape is an approximation, not a surveyed boundary.';

/** Explains why a permanent body feature has no age and no confirm loop (D53). */
export const BODY_FEATURE_CAVEAT =
  'A known seasonal feature of this water body — weak every season regardless of recent cold.';

/**
 * The one line a promoted pin carries in its drawer (D53 amendment, N5c).
 *
 * Promotion no longer hides the sighting it came from, so for the rest of that season the map shows
 * both: a hazard somebody reported on a date, and a permanent feature saying this is a thing the lake
 * does. Without a line joining them, that reads as two independent warnings about the same ice, which
 * over-counts the evidence — precisely the error the amendment exists to avoid in the other direction.
 *
 * Written to keep the two claims distinct rather than to merge them: *this* is a sighting, and the
 * spot is *also* marked as a standing feature. Neither sentence is a prediction (D3).
 */
export const ALSO_A_KNOWN_FEATURE =
  'This spot is also marked as a known feature of the lake — a standing note about what forms here, separate from this sighting.';

/**
 * The line above a consensus footprint — several pins the app judged to be the same hazard (D80).
 *
 * Says what was actually observed and leaves the inference to the reader: *this many people marked
 * this*, not *this is definitely there*. The count is **pins**, not witnesses, because that is what
 * the outline in front of them represents and what the list below it enumerates; the witness count
 * lives in the confirmer clause, where it always has.
 */
export function consensusSummary(memberCount: number): string {
  return `${memberCount} skaters have marked this spot separately — shown as one area below.`;
}
