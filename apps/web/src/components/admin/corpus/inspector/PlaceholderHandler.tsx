import { WATER_BODY_CLASS_LABELS } from '@skating/core';
import type { ReactNode } from 'react';

import { ageInWords } from '@/lib/ages';

import {
  InspectorFrame,
  InspectorHeadAge,
  InspectorHeadEnd,
  InspectorHeadTitle,
} from '../../inspector/InspectorFrame';
import { useInspectorContext } from '../../inspector/inspectorContext';
import type { CorpusTaskItemView } from '../corpusTypes';
import {
  acresText,
  FACT_ACRES,
  FACT_BODY,
  FACT_CLAIMS,
  FACT_CLASS,
  FACT_FILED,
  FACT_LANE,
  FACT_NAMES,
  FACT_WHERE,
  LANE_LABELS,
  NOT_RECORDED,
  PLACEHOLDER_LINE,
  TASK_HEAD,
} from '../words/corpusWords';
import { BodyLink } from './BodyLink';
import type { CorpusHandlerProps } from './handlerRegistry';

/**
 * **The handler for a lane whose handler hasn't landed** — the task's facts, read only, with no
 * actions: the lane, when it was filed, the body (where, its class, its acres), and the lane's own
 * few facts (the names in conflict, the catalogs' classes). One line says the decisions aren't drawn
 * here yet, and the head's *Open in Body →* is the way on, so a task is never a dead end. Never a
 * note about the build.
 */
export function PlaceholderHandler({ item, locked, now }: CorpusHandlerProps) {
  const { linkFor } = useInspectorContext();
  const facts: [string, ReactNode][] = [
    [FACT_LANE, LANE_LABELS[item.lane]],
    [FACT_FILED, ageInWords(item.filedAt, now)],
    [FACT_BODY, item.body.name],
    ...(item.body.place === '' ? [] : [[FACT_WHERE, item.body.place] as [string, ReactNode]]),
    [FACT_CLASS, WATER_BODY_CLASS_LABELS[item.body.cls]],
    ...(item.body.acres === null
      ? []
      : [[FACT_ACRES, acresText(item.body.acres)] as [string, ReactNode]]),
    ...laneFacts(item),
  ];
  return (
    <InspectorFrame
      locked={locked}
      head={
        <>
          <InspectorHeadTitle>{TASK_HEAD[item.lane]}</InspectorHeadTitle>
          <InspectorHeadAge>{ageInWords(item.filedAt, now)}</InspectorHeadAge>
          <InspectorHeadEnd>
            <BodyLink bodyId={item.body.id} linkFor={linkFor} />
          </InspectorHeadEnd>
        </>
      }
    >
      <p
        data-slot="corpus-placeholder-line"
        className="m-0 border-0 border-b border-solid border-line px-gutter py-(--space-4) text-row leading-body text-fg1"
      >
        {PLACEHOLDER_LINE}
      </p>
      <dl
        data-slot="corpus-placeholder-facts"
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

/** Each lane's few facts beyond the body's. */
function laneFacts(item: CorpusTaskItemView): [string, ReactNode][] {
  switch (item.lane) {
    case 'nameConflicts':
      return [[FACT_NAMES, item.names.map((n) => `“${n.value}”`).join(' · ')]];
    case 'classConflicts':
      return [
        [
          FACT_CLAIMS,
          item.claims === null
            ? NOT_RECORDED
            : item.claims
                .map((c) => `${c.source.toUpperCase()} ${WATER_BODY_CLASS_LABELS[c.cls]}`)
                .join(' · '),
        ],
      ];
  }
}
