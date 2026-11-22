import type { Doc } from '@skating/convex/dataModel';
import type { Confidence, RequestKind, ReviewReason } from '@skating/core';

import type { PreviewAsk, PreviewIntake } from './bodiesData';
import type { PreviewFacts } from './bodiesReads';

/**
 * **How the preview words an open ask** — every word here in one place, so the founder can read and
 * change them together. `bodies.preview` returns asks as facts (a request's kind, name and note; a
 * place name's emails; a flag's reason); this module turns them into the kicker, title and sub-line
 * the board draws ("Bay name · Inbox", “Shaker cove”, "Near the Shaker Bridge launch").
 *
 * The board supplied "Bay name", "Place name · 12 emails" and the quoted title. The rest — the
 * other request kinds, what a request that names nothing asks for, and a flag's reason — the mock
 * did not supply; the founder approved them as written on 2026-11-14 (the phase doc lists them
 * under *wording the mock did not supply*).
 */

/** A request's kind, as an ask's kicker names it. */
export const REQUEST_WORDS: Record<RequestKind, string> = {
  activate: 'Activation',
  admit: 'Admission',
  restore: 'Restoration',
  contest_access: 'Access contested',
  takedown: 'Takedown',
  name_bay: 'Bay name',
  name_landmark: 'Landmark name',
};

/** What a request asks for, when it names nothing ("Make it active"). */
export const REQUEST_ASKS: Record<RequestKind, string> = {
  activate: 'Make it active',
  admit: 'Add it to the map',
  restore: 'Bring it back',
  contest_access: 'Reopen its access',
  takedown: 'Take it down',
  name_bay: 'Name a bay',
  name_landmark: 'Name a landmark',
};

/** A flag's reason, in words. */
export const FLAG_WORDS: Record<Doc<'contentFlags'>['reason'], string> = {
  unsafe_false_report: 'Dangerously false ice report',
  spam: 'Spam',
  harassment: 'Harassment',
  inappropriate: 'Inappropriate',
  auto_low_quality: 'Rated unhelpful',
  no_public_access: 'No public access',
  other: 'Other',
};

/** One of `bodies.preview`'s open asks (facts), worded for the preview. */
export function askFrom(ask: PreviewFacts['asks'][number]): PreviewAsk {
  switch (ask.kind) {
    case 'request':
      return {
        id: ask.id,
        item: `request:${ask.id}`,
        kicker: `${REQUEST_WORDS[ask.requestKind]}${askersWords(ask.askers)} · Inbox`,
        title: ask.name !== null ? `“${ask.name}”` : REQUEST_ASKS[ask.requestKind],
        sub: ask.note,
      };
    case 'placeName':
      return {
        id: ask.id,
        kicker: `Place name · ${ask.messages.toLocaleString('en-US')} ${ask.messages === 1 ? 'email' : 'emails'}`,
        title: `“${ask.name}”`,
        sub: null,
      };
    case 'flag':
      return {
        id: ask.id,
        // The flag's own item in the Inbox (B01-5e: the Inbox decides every flag, a photo's too).
        item: `flag:${ask.id}`,
        kicker: 'Flag · Inbox',
        title: FLAG_WORDS[ask.reason],
        sub: null,
      };
  }
}

/**
 * " · asked by 3": how many people have the same question open, when more than the one (a floor,
 * "10+", past the server's count). Nothing for one asker, nor for a read that didn't count them.
 */
function askersWords(askers: { count: number; capped: boolean } | undefined): string {
  if (askers === undefined || (askers.count <= 1 && !askers.capped)) return '';
  return ` · asked by ${askers.count.toLocaleString('en-US')}${askers.capped ? '+' : ''}`;
}

/** An intake review reason, as the preview names it (one body's, so singular). */
export const INTAKE_WORDS: Record<ReviewReason, string> = {
  'duplicate-candidate': 'Possible duplicate',
  'same-source-duplicate': 'One catalog lists it twice',
  'bay-without-parent': 'A bay with no parent',
  'class-dissent': 'A catalog says it isn’t water we cover',
  'class-conflict': 'The catalogs disagree on its class',
  'name-conflict': 'The catalogs disagree on its name',
};

/** How sure the record is of the contested fact, in words. */
const CONFIDENCE_WORDS: Record<Confidence, string> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
  none: 'none',
};

/** One of `bodies.preview`'s intake reasons (facts), worded: what, what's stored beside it, and
 *  whether it's advisory (nothing wrong, only better). */
export function intakeFrom(item: PreviewFacts['intake'][number]): PreviewIntake {
  const detail =
    item.detail === null
      ? null
      : 'candidates' in item.detail
        ? `Overlaps ${item.detail.candidates.toLocaleString('en-US')} ${item.detail.candidates === 1 ? 'body' : 'bodies'}`
        : `Confidence: ${CONFIDENCE_WORDS[item.detail.confidence]}`;
  const parts = [detail, item.advisory ? 'Advisory' : null].filter((p): p is string => p !== null);
  return {
    reason: item.reason,
    title: INTAKE_WORDS[item.reason],
    sub: parts.length === 0 ? null : parts.join(' · '),
  };
}
