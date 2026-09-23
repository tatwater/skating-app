/**
 * The Claude prompts — the stable system block (the vocabulary and the rules) and the per-text user
 * turn (the candidates, the title, the text). Pure, so the prompts are testable and the eval can
 * diff them between runs.
 *
 * The system prompt is written for transcription, not judgment: every rule says "the author said",
 * never "the ice is". The engine is a reader of one skater's words; the author confirms every value
 * (D196) and nothing here may say or imply that ice is safe (D3).
 */

import type { BodyCandidate, ExtractionInput, Vocabulary } from '../contract';

/** Short glosses for the values whose community meaning a model may not know. Exported so the eval reviewer can show them beside each option. */
export const GLOSS: Record<string, string> = {
  black_ice: 'clear, dark, transparent new ice',
  snow_ice: 'white ice formed from snow slush freezing on top',
  white_ice: 'opaque white ice',
  gray_ice: 'gray, often rotting or refrozen ice',
  shell_ice: 'a thin shell over air or water, breaks through to another layer',
  sandwich_ice: 'layered ice with water or slush between layers',
  crust_ice: 'a hard crust over softer ice or snow',
  pack_ice: 'broken plates refrozen together',
  plate_ice: 'large flat plates, often with seams',
  candled_ice: 'vertical candle-like crystals, rotten spring ice',
  orange_peel: 'a fine dimpled texture',
  rubble: 'broken ice chunks frozen in',
  frozen_chop: 'wind chop frozen in place',
  windswept: 'blown clear of snow',
  overflow: 'water on top of the ice',
  drain_hole: 'a hole where water drains through the ice',
  wind_hole: 'open water kept open by wind',
  slush_hole: 'a soft slush spot, often over a spring',
  thawed_rotten: 'thawed, rotten, honeycombed ice',
  ridge_crossing: 'a place a pressure ridge could be crossed',
  wet_crack: 'a working, wet crack',
  shell_area: 'an area of shell ice',
  ice_heave: 'a heave or buckle',
  spring_current: 'a spring or an inlet/outlet current keeping ice weak',
  gas_hole: 'a hole kept open by gas from the bottom',
  reef_hole: 'a hole over a reef or shoal',
  dont_go: 'the author says not to go',
  experienced_only: 'the author says only experienced skaters should go',
  not_for_beginners: 'the author says it is not for beginners',
  beginner_friendly: 'the author says it is fine for beginners',
  on_ice: 'the author was on the ice',
  shore: 'the author looked from shore, a car, a drone, a photo, a window',
  secondhand: 'the author is relaying what someone else told them',
  skim: 'a skim of new ice, not yet skateable',
  lanes: 'lanes or paths of bare ice through snow',
  didnt_matter: 'snow was present but did not affect the skating',
  slowed_me: 'snow slowed the skating',
  avoided_areas: 'the author avoided snowy areas',
  poke: 'a pole or spike test counted in pokes; person-relative, not inches',
  middle: 'the middle of the body, away from shore',
  near_shore: 'near the shore, whichever shore',
  head: 'the back of a named bay (only with a bay)',
  mouth: 'the mouth of a named bay, toward the main lake (only with a bay)',
  icy_lot: 'the parking area is icy',
  mud_at_launch: 'mud at the launch',
  plank_needed: 'a plank or board is needed to get on',
  walk_in: 'a walk from the car to the ice',
  plowed_trail: 'a plowed trail to or on the ice',
  snowed_in: 'the access is snowed in',
};

function list(values: readonly string[]): string {
  return values.map((v) => (GLOSS[v] ? `${v} (${GLOSS[v]})` : v)).join(', ');
}

/** The stable system prompt for a vocabulary. Deterministic: same vocabulary, same bytes. */
export function systemPrompt(vocab: Vocabulary): string {
  return `You transcribe one skater's own words about lake ice into structured fields. The text is one email or post from a community of Nordic (wild) ice skaters in Vermont, New Hampshire, New York, Maine and Quebec. You are a careful reader, not a judge: every value you return is something THIS AUTHOR said or clearly meant about a body of water they name, and you quote the exact words that say it. You never add what the author did not say, and you never describe ice as safe.

## Output

Return one report per (body of water, visit). A visit is one time on or at one body: an email about two lakes yields two reports; a morning skate and an evening re-check of the same lake yield two reports with visit 0 and visit 1. A report needs a body: if the author names a lake that is not among the candidates, set bodyRef to null and bodyName to the name as written. If the text names no body at all, return no reports. Questions, plans and gear talk with no observation produce no report.

For each report, "note" is the author's own sentences about that body, verbatim, joined — nothing rewritten.

Each report carries a flat list "values". One entry per value, with:
- "field": which field it is (the names below).
- "value": the enum key (black_ice, dont_go, on_ice, …); for thickness, the method; for endTime, the local clock time; for snowDepthInches, the word "depth".
- "confidence": 0 to 1 — how sure you are the author said or meant exactly this value. 0.95+ only when the words are unambiguous ("black ice", "3 inches by the auger"). 0.5–0.8 when you are inferring from paraphrase ("the good stuff" → black_ice). Below 0.5 when it is a guess.
- "quote": the exact span of the author's text (or title) the value comes from — verbatim, no paraphrase, at most 160 characters. "quoteField" says whether it is from the title or the text.
- optional "where" (below), "inches" / "minInches" / "maxInches" / "pokeCount" / "supportable" for thickness and snow depth, "precision" for endTime, and a short "note" when the author qualifies the value.

## Fields

- quality: one of ${list(vocab.qualities)} — the author's overall word for the skating.
- suitability: one of ${list(vocab.suitabilities)} — who the author says should go. Only when the author says so.
- observedFrom: one of ${list(vocab.observedFrom)}. Default is on_ice when the author skated; use shore for a drive-by, a look from a window, a drone, a webcam; secondhand for a relayed report.
- sighting: one of ${list(vocab.sightings)} — what a shore or secondhand observer saw. Never for an author who was on the ice.
- endTime: when the author got off the ice — value is a local clock time "YYYY-MM-DDTHH:MM" (or "HH:MM" for today), precision "minute" when stated exactly, "half_hour" when approximate ("around 4", "late afternoon" → do not guess a time for "afternoon"; only return a time when the author gives a clock time or a clear anchor like "sunset").
- iceTypes: values from ${list(vocab.iceTypes)}. Each with an optional "where" (below) and a short note if the author qualifies it.
- surfaceTags: values from ${list(vocab.surfaceTags)}. snow_covered and drifted here mean the author described the surface that way.
- snowCoverage: one of ${list(vocab.snowCoverages)}; snowImpediment: one of ${list(vocab.snowImpediments)}; snowDrifts: one of ${list(vocab.snowDrifts)}; snowDepthInches: value "depth" with "inches" set to the number the author gave (a "dusting" is 0.2).
- thickness: one entry per reading; value is the method, one of ${list(vocab.thicknessMethods)}. measured = drilled, augered, tape, fishing hole measured by the author; estimated = eyeballed, from a crack, from fishing holes seen, from someone else's number; poke = a pole test — put the count in pokeCount and the author's inch guess (if any) in the inch fields. Numbers in inches: "inches" for a single number, minInches/maxInches for a range, minInches alone for "at least" / "4+". supportable true/false only when the author uses the word (supportable, unsupportable, held me, went through). "where" when the reading is located.
- hazards: values from ${list(vocab.hazardTypes)} — each with a "where" when located. open_water includes leads; pressure_ridge includes ridges and folds; wet_crack is a working crack; thin_ice when the author says thin.
- accessConditions: values from ${list(vocab.accessConditions)} — conditions at the launch or lot, not blockers.

## where

A "where" says which part of the body a value is about: "extent" one of ${list(vocab.whereExtents)} (whole = the author says the whole lake, mostly, patches); "sector" one of ${list(vocab.sectors)} — compass sectors are the author's compass words ("the north end" → N, "the northeast corner" → NE; "the middle" → middle; "along the shore" → near_shore); "subAreaId" when the author names a candidate's bay (use the bay's id); "placeName" for a named landmark that is not a candidate bay ("off Shelburne Point", "by the island"). Omit "where" when the author does not locate the value.

## Misses

Anything the author says about the ice, the snow, the access or the trip that these fields cannot hold goes in "misses": kind "enum_value" for a value the field lacks (a snow texture like "crusty", an ice type not listed), "field" for a whole thing there is no field for (wind, crowds, wildlife, a time on the ice rather than off it), "where" for a location the where cannot say, "report_kind" for a kind of report these fields cannot represent (a multi-day journal, a season summary), "other" otherwise. "wouldNeed" says what would hold it. Be generous with misses: they are how the form learns what it cannot yet say.

## Rules

- Quote only the author's own current text or title. Never quote a signature, a forwarded message, or a quoted reply.
- Never invent a body, a number, a time, or a location. An author who says "thick enough" gave no number.
- Imperial in: the corpus writes inches; return inches, never centimeters.
- If two candidates could match a name, prefer the one whose place hint matches the text; if still unsure, pick none and return bodyName.`;
}

function candidateLine(c: BodyCandidate): string {
  const parts = [`- ref "${c.ref}": ${c.name}`];
  if (c.aliases.length > 0) parts.push(`(also: ${c.aliases.join(', ')})`);
  if (c.place) parts.push(`— ${c.place}`);
  if (c.subAreas.length > 0) {
    parts.push(
      `bays: ${c.subAreas
        .map(
          (s) =>
            `${s.name} [id ${s.id}]${s.aliases.length > 0 ? ` (also: ${s.aliases.join(', ')})` : ''}`,
        )
        .join(', ')}`,
    );
  }
  return parts.join(' ').replace(' bays:', '; bays:');
}

/** The per-text user turn. */
export function userPrompt(input: ExtractionInput): string {
  const parts: string[] = [];
  parts.push(
    input.bodyCandidates.length > 0
      ? `Candidate bodies of water (use the ref when the author means one of these):\n${input.bodyCandidates.map(candidateLine).join('\n')}`
      : 'Candidate bodies of water: none offered — return bodyRef null and the name as written.',
  );
  if (input.writtenAtMs !== undefined) {
    parts.push(
      `Written at: ${new Date(input.writtenAtMs).toISOString()} (time zone ${input.timeZone}). "Today" and "yesterday" are relative to this.`,
    );
  }
  if (input.title) parts.push(`Title:\n${input.title}`);
  parts.push(`Text:\n${input.text}`);
  return parts.join('\n\n');
}
