/**
 * **What raised an intake question, as evidence a settle can be held to** (B01-6a, D305).
 *
 * A moderator who settles a name or class conflict settles it *on the facts the catalogs gave*. The
 * next campaign re-raises every reason it finds, whatever was decided — so the import asks this rule
 * what raised the reason now, and compares it with what it was settled on: the same evidence holds
 * the settle (the reason is dropped), different evidence asks again (the settle is dropped and the
 * task files anew). The settle and the import both ask this one function, so the two can't drift.
 *
 * **What counts as evidence, and what deliberately doesn't:**
 *
 * - A name conflict's is the **distinct catalog spellings**, each by its normalized key, sorted. A
 *   moderator's own (`user`) claim is never evidence — it is the decision, not what raised it. Nor is
 *   *which* catalogs publish a spelling (`sources`): the campaign that first records `sources`, or a
 *   second catalog newly agreeing with a spelling already there, changes nothing a moderator chose
 *   between. A new spelling, or one withdrawn, does.
 * - A class conflict's is **each catalog's class with its own token**. A claim stored before the
 *   campaign that carries tokens has none, so that campaign asks a class conflict settled before it
 *   once more: the settle wasn't made on the claims it brings (D305, question 1 as ruled).
 * - Facts not stored at all (no catalog claims) are {@link UNRECORDED_EVIDENCE}: the first campaign
 *   that records them differs, and asks again.
 *
 * Nothing here says anything about the ice (D3): evidence is what the catalogs published, never a
 * condition.
 */

import type { ReviewReason } from './confidence';

/** The stored facts the evidence is read from: the body's catalog claims. */
export type EvidenceRecord = {
  nameClaims?: readonly { source: string; value: string; sources?: readonly string[] }[];
  classClaims?: readonly { source: string; value: string; token?: string }[];
};

/** Evidence over facts not yet stored (no class claims). */
export const UNRECORDED_EVIDENCE = 'unrecorded';

/**
 * What raised `reason` on `record`, as a deterministic string (at most 1 KiB). A name conflict's:
 * the distinct catalog spellings only (never a `user` claim) — their normalized keys, sorted — and
 * never which catalogs publish them, so the campaign that first records `sources`, or a catalog
 * newly agreeing with a spelling already there, re-asks nothing; a new spelling, or one withdrawn,
 * does. A class conflict's: its claims with their tokens. `null` for a reason 6a doesn't settle
 * (`class-dissent` included: 6b adds the refusals, D306). One rule for the settle and the import
 * (D305).
 */
export function reviewEvidence(reason: ReviewReason, record: EvidenceRecord): string | null {
  switch (reason) {
    case 'name-conflict':
      return nameEvidence(record);
    case 'class-conflict':
      return classEvidence(record);
    default:
      return null;
  }
}

/** The most bytes a fingerprint is stored at: past it, a digest of the readable form stands in. */
export const EVIDENCE_MAX_BYTES = 1024;

/** A spelling's key: what makes two spellings the same spelling (case, spacing and Unicode form). */
export function spellingKey(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function nameEvidence(record: EvidenceRecord): string {
  const keys = new Set<string>();
  for (const claim of record.nameClaims ?? []) {
    if (claim.source === 'user') continue;
    const key = spellingKey(claim.value);
    if (key.length > 0) keys.add(key);
  }
  if (keys.size === 0) return UNRECORDED_EVIDENCE;
  return bounded(`names:${JSON.stringify([...keys].sort(compareCodeUnits))}`);
}

function classEvidence(record: EvidenceRecord): string {
  const entries = new Set<string>();
  for (const claim of record.classClaims ?? []) {
    if (claim.source === 'user') continue;
    entries.add(JSON.stringify([claim.source, claim.value, claim.token ?? null]));
  }
  if (entries.size === 0) return UNRECORDED_EVIDENCE;
  return bounded(`classes:[${[...entries].sort(compareCodeUnits).join(',')}]`);
}

/** Locale-free, so the order is the same on every runtime. Its inputs are distinct (a set's). */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : 1;
}

const encoder = new TextEncoder();

/**
 * The fingerprint as stored: the readable form while it fits {@link EVIDENCE_MAX_BYTES}, else its
 * kind and a 64-bit digest of it (two FNV-1a lanes) — still deterministic, still unequal for unequal
 * evidence but for a collision no catalog's spellings will meet.
 */
function bounded(readable: string): string {
  if (encoder.encode(readable).length <= EVIDENCE_MAX_BYTES) return readable;
  const kind = readable.slice(0, readable.indexOf(':'));
  return `${kind}#${fnv1a(readable, 0x811c9dc5)}${fnv1a(readable, 0x050c5d1f)}`;
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
