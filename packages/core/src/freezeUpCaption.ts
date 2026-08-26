/**
 * What a scrubber stop says about itself (N6e §C4, D84, D150).
 *
 * ## The date is content, not a caption
 *
 * A timeline invites inference far harder than a still image does. Scrubbing feels like watching,
 * and watching implies continuity that 2–4 usable frames a month does not have — so every frame
 * carries its own date and its own caveat, travelling *with* the frame rather than sitting as
 * furniture around the control.
 *
 * ## What this may never say
 *
 * **D150 governs every string here: report a measurement and its source, never a verdict.** The gap
 * this guards is short and tempting — "82% water" to "not frozen" to "not skateable" — and the last
 * two are claims no instrument in this pipeline can support. Nothing sees thickness (D147), and the
 * one surface skaters most want is the one optical gets most wrong: black ice reads as *water*.
 *
 * So there is deliberately **no ice phrasing in this module at all.** Turning a classification into
 * words is N6g's problem, under a decision written for it. This says when the picture was taken, what
 * took it, and what was in the way.
 *
 * ## Why it lives in core
 *
 * `lakeCaption`'s first rule, one module over: generated rather than written, so web and mobile
 * render identically and the whole thing is unit-testable. A second copy of a sentence a lawyer
 * might read is a second chance for one of them to drift.
 */

import type { TimelineStop } from './imageryTimeline';

/** Bands the archive publishes, and what to call each in front of a skater. */
const SOURCE_LABELS: Record<string, string> = {
  visual: 'Sentinel-2 true color',
  scl: 'Sentinel-2 scene classification',
  vh: 'Sentinel-1 radar (VH)',
};

/**
 * How to read this band — **one line, and it names the ambiguity rather than the strength.**
 *
 * > **Founder, 2026-08-26:** *"I don't really know how to read it (it all looks like grey fuzz to
 * > me) so I'm not sure how helpful it will be to others either."*
 *
 * The band toggle says what instrument took the picture, which tells a skater nothing about what
 * they are looking at. `Sentinel-1 radar (VH)` is a provenance label; *"dark is smooth ice **or**
 * open water"* is the thing that decides whether they drive two hours.
 *
 * ⚠ **Each line leads with what the band cannot tell you**, because that is the part a picture
 * cannot say for itself and the part that gets someone hurt. Radar's failure mode is precisely our
 * use case — smooth new black ice is specular and returns dark, and so does calm open water — and a
 * hint that led with *"sees through cloud!"* would sell the strength and bury the trap. Optical has
 * the mirror-image problem: snow, ice and cloud are all simply white.
 *
 * `null` for a band with nothing honest and short to say, which renders as no line at all rather
 * than as filler.
 */
const SOURCE_HINTS: Record<string, string> = {
  visual: 'White may be snow, ice or cloud — true color cannot tell them apart.',
  vh: 'Sees through cloud and darkness. Bright is rough or snow-covered ice; dark is smooth ice — or open water.',
  scl: "ESA's own guess at what each pixel is, made from bands the eye cannot see.",
};

/** A stop's own account of itself, in parts so a client can weight them differently. */
export interface StopCaption {
  /** `22 Dec 2025`. The content (D84) — render it as such, not as a tooltip. */
  date: string;
  /** What took the picture, so a reader can weigh it. Never omitted. */
  source: string;
  /** What was in the way, or `null` when nothing was. Never a verdict. */
  caveat: string | null;
}

/** `22 Dec 2025` — short, unambiguous, and not locale-guessing about day/month order. */
export function frameDateLabel(capturedAt: string): string {
  const at = new Date(capturedAt);
  if (Number.isNaN(at.getTime())) return 'unknown date';
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}

/** What instrument produced this frame. Falls back to the raw band rather than inventing a name. */
export function frameSourceLabel(band: string): string {
  return SOURCE_LABELS[band] ?? band;
}

/** How to read this band, or `null` where we have nothing honest and short to say. */
export function frameSourceHint(band: string): string | null {
  return SOURCE_HINTS[band] ?? null;
}

function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * The caveat riding with one stop, or `null` where there is nothing to say.
 *
 * ## Three shapes, and the difference between them is the point
 *
 * **Per-lake cloud**, where a manifest gave us `clearPct`: *"38% of the lake under cloud."* This is
 * the specific claim, and it is only sayable because ESA's classifier counted pixels over this
 * shoreline.
 *
 * **Regional cloud**, where only the granule figure exists: *"94% cloud over the region."* ⚠ The
 * words *over the region* are load-bearing rather than hedging — `eo:cloud_cover` describes a 110 km
 * tile, so two lakes in one granule always report the same number, and *"94% cloud over Lake George"*
 * would be a claim about a lake we did not measure.
 *
 * **Coverage**, where the pass clipped an edge: *"only 15% of the lake in this pass."* Captioning
 * that as cloud would explain the wrong problem to somebody wondering why the picture looks partial.
 */
export function stopCaveat(stop: TimelineStop): string | null {
  const coveragePct = stop.stats?.coveragePct ?? null;
  if (stop.blockedBy === 'coverage' && coveragePct !== null) {
    return `only ${pct(coveragePct)}% of the lake in this pass`;
  }

  const clearPct = stop.stats?.clearPct ?? null;
  if (clearPct !== null) {
    const obscured = pct(1 - clearPct);
    return obscured > 0 ? `${obscured}% of the lake under cloud` : null;
  }

  const cloud = stop.frame.cloudCoverPct;
  // `null` is "the source did not report one" on optical and "the question does not apply" on radar,
  // and neither is a caveat — inventing one would put a cloud warning on a sensor that sees through
  // cloud. See `IndexedFrame.cloudCoverPct`.
  if (cloud === null) return null;
  return `${Math.round(cloud)}% cloud over the region`;
}

/** Everything a stop says about itself, assembled. */
export function stopCaption(stop: TimelineStop): StopCaption {
  return {
    date: frameDateLabel(stop.frame.capturedAt),
    source: frameSourceLabel(stop.frame.band),
    caveat: stopCaveat(stop),
  };
}

/**
 * The honest description of a *gap* between two stops.
 *
 * > *"open water observed 22 Nov, frozen by 22 Dec"* — never *"it froze in early December."*
 *
 * With cloud knocking out three passes in four, a lake gets 11–12 usable optical frames a winter and
 * a freeze-up can sit inside a 30-day hole. **A bracket is the strongest true statement available**,
 * and the phrasing has to survive that rather than round it away — which is why this returns the
 * number of days rather than a word like "recently".
 */
export function gapDaysBetween(earlier: string, later: string): number | null {
  const a = new Date(earlier).getTime();
  const b = new Date(later).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}
