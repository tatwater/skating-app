import type { ReactNode } from 'react';

import { Button } from '@/components/kit/button';
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
import { elsewhereFor } from './elsewhere';
import { handlerKeyOf, type InboxHandlerProps } from './handlerRegistry';
import { InspectorFrame, InspectorHeadAge, InspectorHeadTitle } from './InspectorFrame';
import { useInspectorContext } from './inspectorContext';

/**
 * **The handler for a kind whose handler hasn't landed** — the item's facts, read only, with no
 * actions: which lane, when it was filed and by how many, the body, and the kind's own few facts
 * (a flag's reasons and subject, an ask's kind and note, a ticket's words). Over them, one line says
 * where this kind is decided for now, with a link there (`elsewhere`), so an item the Inbox can't
 * decide yet is never a dead end. Never a note about the build.
 */
export function PlaceholderHandler({ item, locked, now }: InboxHandlerProps) {
  const { linkFor, canReadSupport = false } = useInspectorContext();
  const elsewhere = elsewhereFor(handlerKeyOf(item), item, canReadSupport);
  const facts: [string, ReactNode][] = [
    [FACT_LANE, LANE_LABELS[item.lane]],
    [FACT_FILED, ageInWords(item.filedAt, now)],
    [FACT_MEMBERS, people(item.memberCount, item.memberCountIsFloor)],
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
      {elsewhere !== null && (
        <div
          data-slot="inbox-placeholder-elsewhere"
          className="flex flex-col gap-(--space-2_5) border-0 border-b border-solid border-line px-gutter py-(--space-4)"
        >
          <p className="m-0 text-row leading-body text-fg1">{elsewhere.line}</p>
          <span className="flex flex-wrap items-center gap-(--space-2_5)">
            {elsewhere.links.map((link) => (
              <Button
                key={link.to}
                variant="link"
                size="xs"
                data-slot="inbox-placeholder-link"
                data-to={link.to}
                // The console's own pages: the same tab, the browser's back returns here.
                nativeButton={false}
                render={
                  linkFor?.(link.to) ?? (
                    // biome-ignore lint/a11y/useAnchorContent: the link chip renders its label into it
                    <a href={link.to} />
                  )
                }
              >
                {link.label}
              </Button>
            ))}
          </span>
        </div>
      )}
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
