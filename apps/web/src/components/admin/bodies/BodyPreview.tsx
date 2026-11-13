import { waterBodyClassLabel } from '@skating/core';
import { type ComponentProps, cloneElement, type ReactElement, type ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button, buttonVariants } from '@/components/kit/button';
import { HistoryList, HistoryRow } from '@/components/kit/grid-list';
import { Kbd } from '@/components/kit/kbd';
import { ListEnd } from '@/components/kit/list-end';
import { Section } from '@/components/kit/section-slug';
import { SkeletonBlock, SkeletonText } from '@/components/kit/skeleton';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { LedStrip } from '@/components/kit/trace-chart';
import { cn } from '@/lib/utils';
import { completenessSegments, missingSentence } from '../body/completeness';
import { historyWhen } from '../shell/consoleTime';
import type { BodyPreviewData } from './bodiesData';
import { acresText } from './bodiesModel';
import { coordText, OutlineStill } from './OutlineStill';

/**
 * The preview pane (boards 5.1–5.3, right): the body the list has open, read before it's opened
 * in full — its outline, its lockup (class and place, the name, area, depth, elevation), its
 * reports this season and all-time, how complete its record is, what's asked of it, and what
 * changed last. One action at its foot: *Open in Body →* (⏎).
 *
 * Each block draws what its read returned and nothing else: a block whose read doesn't exist yet
 * (`null`) is left out, never drawn as a zero. `undefined` is the body on its way.
 */

type BodyPreviewProps = {
  /** The open body; `undefined` while it loads, `null` with none open. */
  data: BodyPreviewData | null | undefined;
  /** The instant ages are read against. */
  now: number;
  /** The router's link to the body's console (`<Link to="/admin/body/$id" … />`). */
  bodyLink?: (id: string) => ReactElement;
  /** Opens the body's console (⏎ in the pane; the route says where). */
  onOpen?: (id: string) => void;
};

export function BodyPreview({ data, now, bodyLink, onOpen }: BodyPreviewProps) {
  return (
    <div data-slot="body-preview" className="flex h-full min-h-0 flex-col">
      <div
        data-slot="preview-head"
        className="flex h-(--space-10) shrink-0 items-end border-0 border-b border-solid border-line px-gutter pb-(--space-3)"
      >
        <span className="text-assist leading-none font-semibold tracking-kick text-fg uppercase">
          Preview
        </span>
      </div>
      <div
        data-slot="preview-scroll"
        className="min-h-0 flex-1 overflow-y-auto px-gutter pb-(--space-20)"
        aria-busy={data === undefined || undefined}
      >
        {data === undefined ? (
          <PreviewLoading />
        ) : data === null ? (
          <ListEnd className="mt-(--space-3)">No body open</ListEnd>
        ) : (
          <PreviewBody data={data} now={now} />
        )}
      </div>
      {data != null && (
        <div data-slot="preview-actbar" className="shrink-0 px-(--space-2) pb-(--space-2)">
          <div className="flex border border-solid border-line p-(--space-2)">
            {bodyLink !== undefined ? (
              // Navigation is a link (the router's), worn in the bar's button face.
              cloneElement(
                bodyLink(data.id) as ReactElement<ComponentProps<'a'>>,
                {
                  'data-slot': 'open-in-body',
                  className: cn(buttonVariants(), 'w-full no-underline'),
                  children: <OpenLabel />,
                } as ComponentProps<'a'>,
              )
            ) : (
              <Button data-slot="open-in-body" className="w-full" onClick={() => onOpen?.(data.id)}>
                <OpenLabel />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OpenLabel() {
  return (
    <span data-slot="label" className="inline-flex items-center gap-[inherit]">
      Open in Body →
      <Kbd variant="dim" aria-hidden="true">
        ⏎
      </Kbd>
    </span>
  );
}

function PreviewLoading() {
  return (
    <div className="flex flex-col gap-(--space-4)">
      <SkeletonBlock className="-mx-gutter aspect-square" />
      <SkeletonText width="40%" />
      <SkeletonText width="70%" />
    </div>
  );
}

/** "Reservoir · Enfield, NH" with the other towns behind "+1". */
function placeKicker(data: BodyPreviewData): ReactNode {
  const where =
    data.town !== null
      ? `${data.town}, ${data.states.join(' · ')}`
      : data.states.length > 0
        ? data.states.join(' · ')
        : null;
  return (
    <>
      {waterBodyClassLabel(data.bodyClass)}
      {where !== null && ` · ${where}`}
      {data.moreTowns.length > 0 && (
        <>
          {' · '}
          <Tooltip>
            <TooltipTrigger variant="text" render={<span />}>
              +{data.moreTowns.length}
            </TooltipTrigger>
            <TooltipContent>Also in: {data.moreTowns.join(', ')}</TooltipContent>
          </Tooltip>
        </>
      )}
    </>
  );
}

/** "9.4 / 24 m", either half alone when only one is recorded. */
function depthText(mean: number | null, max: number | null): string | null {
  const f = (m: number) => (m < 10 ? m.toFixed(1) : Math.round(m).toString());
  if (mean !== null && max !== null) return `${f(mean)} / ${f(max)} m`;
  if (max !== null) return `${f(max)} m`;
  if (mean !== null) return `${f(mean)} m`;
  return null;
}

/** "43.63 −72.15 · 6 put-ins · 2 bays", each count only when it's recorded and not zero. */
function stillLabel(data: BodyPreviewData): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return [
    coordText(data.centroid.lat, data.centroid.lng),
    ...(data.putIns !== null && data.putIns.length > 0
      ? [n(data.putIns.length, 'put-in', 'put-ins')]
      : []),
    ...(data.bays !== null && data.bays > 0 ? [n(data.bays, 'bay', 'bays')] : []),
  ].join(' · ');
}

const KICK = 'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase';

function PreviewBody({ data, now }: { data: BodyPreviewData; now: number }) {
  const depth = depthText(data.meanDepthM, data.maxDepthM);
  const figures = [
    ...(data.areaSqM !== null ? [{ label: 'Area', value: `${acresText(data.areaSqM)} ac` }] : []),
    ...(depth !== null ? [{ label: 'Depth', value: depth }] : []),
    ...(data.elevationM !== null
      ? [{ label: 'Elevation', value: `${Math.round(data.elevationM)} m` }]
      : []),
  ];
  const missing = data.complete === null ? null : missingSentence(data.complete.missing);
  return (
    <>
      {data.outline !== null && (
        <OutlineStill
          className="-mx-gutter w-[calc(100%+2*var(--gap-gutter))]"
          outline={data.outline}
          putIns={data.putIns ?? []}
          label={stillLabel(data)}
          name={data.name}
        />
      )}
      <div
        data-slot="preview-lockup"
        className="flex flex-col gap-(--space-2) border-0 border-b border-dotted border-line pt-(--space-3_5) pb-(--space-3)"
      >
        <span data-slot="preview-kicker" className={KICK}>
          {placeKicker(data)}
        </span>
        <h2
          data-slot="preview-name"
          className="m-0 text-disp leading-none font-semibold tracking-disp text-fg uppercase"
        >
          {data.name}
        </h2>
        {figures.length > 0 && (
          <dl data-slot="preview-figures" className="m-0 flex gap-(--space-3)">
            {figures.map((f) => (
              <div key={f.label} className="flex flex-col gap-(--space-1_5)">
                <dt className={KICK}>{f.label}</dt>
                <dd className="m-0">
                  <Badge tone="dim" className="normal-case">
                    {f.value}
                  </Badge>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {(data.season !== null || data.allTime !== null) && (
          <StatGrid
            columns={2}
            data-slot="preview-reports"
            className="mt-(--space-1) border-0 border-t border-dotted border-line pt-(--space-2_5)"
          >
            {data.season !== null && (
              <StatTile
                label="This season"
                value={data.season.count}
                unit={data.season.count === 1 ? 'report' : 'reports'}
                {...(data.season.sub !== null && { sub: data.season.sub })}
              />
            )}
            {data.allTime !== null && (
              <StatTile
                label="All-time"
                value={data.allTime.count}
                unit={data.allTime.count === 1 ? 'report' : 'reports'}
                {...(data.allTime.sub !== null && { sub: data.allTime.sub })}
              />
            )}
          </StatGrid>
        )}
        {data.complete !== null && (
          <div
            data-slot="preview-complete"
            className="mt-(--space-1_5) flex flex-col gap-(--space-2)"
          >
            <span className="flex items-baseline gap-(--space-2_5)">
              <span className={KICK}>Complete</span>
              <span className="ms-auto font-(family-name:--family-mono) text-assist leading-none font-medium text-fg tabular-nums">
                {data.complete.have} / {data.complete.of}
              </span>
            </span>
            <LedStrip
              full
              size="tall"
              aria-label="Complete"
              segments={completenessSegments(data.complete)}
            />
            {missing !== null && (
              <span className="text-assist leading-list text-fg3">{missing}</span>
            )}
          </div>
        )}
      </div>
      {data.asks !== null && data.asks.length > 0 && (
        <Section title="Asked of this body" count={data.asks.length} className="mt-(--space-5_5)">
          <ul data-slot="preview-asks" className="m-0 flex list-none flex-col p-0">
            {data.asks.map((ask) => (
              <li
                key={ask.id}
                className="flex flex-col gap-(--space-1) py-(--space-2) ps-(--space-4_5)"
              >
                <span className={KICK}>{ask.kicker}</span>
                <span
                  className={cn(
                    'relative text-body leading-list text-fg',
                    // The hollow circle bullet, centered on the title's line.
                    'before:absolute before:-start-(--space-4_5) before:top-1/2 before:size-(--space-2) before:-translate-y-1/2 before:rounded-full before:border before:border-solid before:border-fg3 before:content-[""]',
                  )}
                >
                  {ask.title}
                </span>
                {ask.sub !== null && (
                  <span className="text-assist leading-list text-fg3">{ask.sub}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {data.history !== null && (
        <Section title="Last changed" count={data.history.length} className="mt-(--space-5_5)">
          {data.history.length > 0 && (
            <HistoryList>
              {data.history.map((row) => (
                <HistoryRow
                  key={row.id}
                  when={historyWhen(row.at, now)}
                  who={row.actor ?? 'The machinery'}
                >
                  {row.words}
                </HistoryRow>
              ))}
            </HistoryList>
          )}
        </Section>
      )}
    </>
  );
}
