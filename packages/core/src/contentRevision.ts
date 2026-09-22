/**
 * What an author changed (D205, A10-5) — the moderator's comparison.
 *
 * `contentRevisions` holds what a Post or a Report *used to say*; the live row says what it says
 * now. Reading a stack of raw snapshots is not the question a moderator has, though. The question
 * is narrow and almost always about one field: **did this edit change a claim?** A thickness that
 * went from 2 inches to 6, a *don't go* that became *good*, a hazard note that lost its warning —
 * those are the edits worth a second look. A reworded sentence is not.
 *
 * So the comparison is a per-field list of what changed, in the sheet's own words, oldest edit
 * first, with the fields that carry a safety claim marked. Nothing here decides anything about the
 * content; it only says what moved, and lets a person read it (D3 — no score, no verdict).
 */

import { formatThicknessReading, type ThicknessReading } from './reportView';
import { describeWhere } from './where';

/** A field on the content block, as a moderator reads it. */
export interface RevisionChange {
  field: string;
  /** The field's name in the sheet's words ("Thickness", "Who is it for?"). */
  label: string;
  /** What it said before this edit; `null` when it said nothing. */
  before: string | null;
  /** What it said after; `null` when the edit cleared it. */
  after: string | null;
  /**
   * Does this field carry a claim about the ice? Marked, never ranked — a moderator decides, and
   * the mark is only there so a thickness change is not lost in a list of reworded notes (D3).
   */
  claim: boolean;
}

/** One edit: when it replaced what came before, and every field it moved. */
export interface RevisionStep {
  replacedAt: number;
  changes: RevisionChange[];
}

/** The fields a content block can carry, in the order the sheet asks for them. */
const FIELDS: { key: string; label: string; claim: boolean }[] = [
  { key: 'title', label: 'Title', claim: false },
  { key: 'body', label: 'The story', claim: false },
  { key: 'skateQuality', label: 'How was it?', claim: true },
  { key: 'suitability', label: 'Who is it for?', claim: true },
  { key: 'observedFrom', label: 'How did you see it?', claim: true },
  { key: 'sighting', label: 'What did you see?', claim: true },
  { key: 'skateEndTime', label: 'Off the ice', claim: true },
  { key: 'skateStartTime', label: 'On the ice', claim: false },
  { key: 'skateEndPrecision', label: 'How exact the end time is', claim: false },
  { key: 'iceTypes', label: 'Ice', claim: true },
  { key: 'surfaceTags', label: 'Surface', claim: true },
  { key: 'snow', label: 'Snow', claim: true },
  { key: 'iceThickness', label: 'Thickness', claim: true },
  { key: 'notes', label: 'The note about this lake', claim: false },
  { key: 'conditions', label: 'Weather', claim: false },
  { key: 'point', label: 'Where on the lake', claim: false },
  { key: 'putInId', label: 'Put-in', claim: false },
  { key: 'showPutIn', label: 'Put-in shown', claim: false },
  { key: 'photoIds', label: 'Photos', claim: false },
];

type Block = Record<string, unknown>;

function isLocated(
  value: unknown,
): value is { type: string; where?: Parameters<typeof describeWhere>[0] } {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/** One value in the sheet's words. `null` when the field said nothing. */
export function describeRevisionValue(
  field: string,
  value: unknown,
  opts: { timeZone?: string; bayNames?: Record<string, string> } = {},
): string | null {
  if (value === undefined || value === null) return null;
  if (field === 'skateEndTime' || field === 'skateStartTime') {
    return typeof value === 'number'
      ? new Intl.DateTimeFormat('en-US', {
          ...(opts.timeZone !== undefined ? { timeZone: opts.timeZone } : {}),
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(value)
      : null;
  }
  if (field === 'iceThickness') {
    const block = value as { readings?: readonly ThicknessReading[]; scope?: string };
    const readings = (block.readings ?? [])
      .map((r) => formatThicknessReading(r))
      .filter((line): line is string => line !== null);
    if (readings.length === 0) return null;
    const scope = block.scope === undefined ? '' : ` — ${block.scope.replace(/_/g, ' ')}`;
    return `${readings.join('; ')}${scope}`;
  }
  if (field === 'iceTypes' || field === 'surfaceTags') {
    const list = Array.isArray(value) ? value : [];
    if (list.length === 0) return null;
    return list
      .map((chip) => {
        if (typeof chip === 'string') return chip.replace(/_/g, ' ');
        if (!isLocated(chip)) return String(chip);
        const where = chip.where ? describeWhere(chip.where, opts.bayNames ?? {}) : '';
        return where ? `${chip.type.replace(/_/g, ' ')} (${where})` : chip.type.replace(/_/g, ' ');
      })
      .join(', ');
  }
  if (field === 'photoIds') {
    const list = Array.isArray(value) ? value : [];
    return list.length === 0 ? null : `${list.length} photo${list.length === 1 ? '' : 's'}`;
  }
  if (field === 'point') {
    const p = value as { lat?: number; lng?: number };
    return typeof p.lat === 'number' && typeof p.lng === 'number'
      ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`
      : null;
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value.trim() === '' ? null : value.replace(/_/g, ' ');
  if (typeof value === 'number') return String(value);
  // Snow, the weather block, anything else object-shaped: its set fields, in a stable order.
  if (typeof value === 'object') {
    const entries = Object.entries(value as Block)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${String(v)}`);
    return entries.length === 0 ? null : entries.join(', ');
  }
  return String(value);
}

/**
 * What changed between two content blocks, field by field. Order is the sheet's, not the object's,
 * so two edits read the same way down the page.
 */
export function diffContentBlocks(
  before: Block,
  after: Block,
  opts: { timeZone?: string; bayNames?: Record<string, string> } = {},
): RevisionChange[] {
  const out: RevisionChange[] = [];
  for (const { key, label, claim } of FIELDS) {
    const wasSet = key in before;
    const isSet = key in after;
    if (!wasSet && !isSet) continue;
    const was = describeRevisionValue(key, before[key], opts);
    const now = describeRevisionValue(key, after[key], opts);
    if (was === now) continue;
    out.push({ field: key, label, before: was, after: now, claim });
  }
  return out;
}

/**
 * The whole history of one row, oldest edit first: each stored snapshot compared with what
 * replaced it — the next snapshot, and for the last one, the live row.
 *
 * `revisions` may arrive in any order; they are sorted by `replacedAt` here, because "what did this
 * edit change" is only answerable against the block that came *next*, and a mis-ordered list would
 * pair an old snapshot with a newer one and report the change backwards.
 */
export function revisionHistory(
  revisions: readonly { replacedAt: number; snapshot: Block }[],
  live: Block,
  opts: { timeZone?: string; bayNames?: Record<string, string> } = {},
): RevisionStep[] {
  const ordered = [...revisions].sort((a, b) => a.replacedAt - b.replacedAt);
  return ordered.map((revision, i) => ({
    replacedAt: revision.replacedAt,
    changes: diffContentBlocks(revision.snapshot, ordered[i + 1]?.snapshot ?? live, opts),
  }));
}

/** Did any edit in this history move a field that carries a claim about the ice? */
export function touchedAClaim(steps: readonly RevisionStep[]): boolean {
  return steps.some((step) => step.changes.some((change) => change.claim));
}
