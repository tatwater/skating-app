import type { ReactNode } from 'react';

import { ageInWords } from '@/lib/ages';

import { REQUEST_WORDS } from '../../bodies/askWords';
import {
  FACT_BODY,
  FACT_FILED,
  FACT_LANE,
  FACT_MEMBERS,
  FACT_NOTE,
  FACT_REASONS,
  FACT_SUBJECT,
  FLAG_WORDS,
  KIND_HEAD,
  LANE_LABELS,
  people,
  TARGET_TITLE,
  TICKET_CHIP,
} from '../words/inboxWords';
import type { InboxHandlerProps } from './handlerRegistry';
import { InspectorFrame, InspectorHeadAge, InspectorHeadTitle } from './InspectorFrame';

/**
 * **The handler for a kind whose handler hasn't landed** — the item's facts, read only, with no
 * actions: which lane, when it was filed and by how many, the body, and the kind's own few facts
 * (a flag's reasons and subject, an ask's kind and note, a ticket's words). Never a note about the
 * build: an operator sees what the item is and decides it elsewhere until its handler arrives.
 */
export function PlaceholderHandler({ item, locked, now }: InboxHandlerProps) {
  const facts: [string, ReactNode][] = [
    [FACT_LANE, LANE_LABELS[item.lane]],
    [FACT_FILED, ageInWords(item.filedAt, now)],
    [FACT_MEMBERS, people(item.memberCount)],
    ...kindFacts(item),
  ];
  return (
    <InspectorFrame
      locked={locked}
      head={
        <>
          <InspectorHeadTitle>{KIND_HEAD[item.kind]}</InspectorHeadTitle>
          <InspectorHeadAge>{ageInWords(item.filedAt, now)}</InspectorHeadAge>
        </>
      }
    >
      <dl
        data-slot="inbox-placeholder-facts"
        className="m-0 grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-(--space-4) px-gutter pt-(--space-4)"
      >
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="flex min-h-(--size-td) items-center border-0 border-b border-dotted border-line text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
              {label}
            </dt>
            <dd className="m-0 flex min-h-(--size-td) min-w-0 flex-wrap items-center gap-(--space-1_5) border-0 border-b border-dotted border-line py-(--space-1_5) text-row leading-list text-fg1">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </InspectorFrame>
  );
}

/** Each kind's few facts beyond the frame's. */
function kindFacts(item: InboxHandlerProps['item']): [string, ReactNode][] {
  switch (item.kind) {
    case 'flag': {
      const reasons = [...new Set(item.flags.map((f) => f.reason))];
      const note = item.flags.find((f) => f.note !== null)?.note ?? null;
      const target = item.target;
      const subject =
        target.exists && target.summary.trim() !== ''
          ? target.summary
          : TARGET_TITLE[target.targetType];
      return [
        // Plain words, wrapping: a reason's name can be longer than a phone's column holds.
        [FACT_REASONS, reasons.map((r) => FLAG_WORDS[r]).join(' · ')],
        [FACT_SUBJECT, subject],
        ...(note === null ? [] : [[FACT_NOTE, note] as [string, ReactNode]]),
      ];
    }
    case 'access':
      return [[FACT_BODY, item.body.name]];
    case 'request': {
      const note = item.asks.find((a) => a.note !== null)?.note ?? null;
      return [
        [FACT_SUBJECT, REQUEST_WORDS[item.requestKind]],
        ...(item.body === null ? [] : [[FACT_BODY, item.body.name] as [string, ReactNode]]),
        ...(note === null ? [] : [[FACT_NOTE, note] as [string, ReactNode]]),
      ];
    }
    case 'place': {
      const name = item.asks.find((a) => a.name !== null)?.name ?? null;
      return [
        [
          FACT_SUBJECT,
          name === null
            ? REQUEST_WORDS[item.placeKind]
            : `${REQUEST_WORDS[item.placeKind]} · “${name}”`,
        ],
        [FACT_BODY, item.body.name],
      ];
    }
    case 'drawn':
      return [
        [FACT_BODY, item.body.name],
        ...(item.drawer === null
          ? []
          : [[FACT_SUBJECT, item.drawer.displayName] as [string, ReactNode]]),
      ];
    case 'ticket':
      return [
        [FACT_SUBJECT, TICKET_CHIP[item.ticket.category]],
        [FACT_NOTE, item.ticket.body],
      ];
  }
}
