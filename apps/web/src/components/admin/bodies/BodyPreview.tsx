import { type DepthSource, isMeasuredDepthSource, waterBodyClassLabel } from '@skating/core';
import { type ComponentProps, cloneElement, type ReactElement, type ReactNode } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button, buttonVariants } from '@/components/kit/button';
import { HistoryList, HistoryRow, KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Kbd } from '@/components/kit/kbd';
import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { Section } from '@/components/kit/section-slug';
import { SkeletonBlock, SkeletonText } from '@/components/kit/skeleton';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { LedStrip } from '@/components/kit/trace-chart';
import { cn } from '@/lib/utils';
import { completenessSegments, missingSentence } from '../body/completeness';
import { IN_NO_TOWN_WORDS, NOT_COMPUTED_WORDS, townWithState } from '../body/frame/bodyModel';
import { NOT_RECORDED } from '../body/tabs/tabStates';
import { countText } from '../overview/overviewModel';
import { isFailed, type Loadable, loaded } from '../reads/consoleReads';
import { historyWhen } from '../shell/consoleTime';
import type { BodyPreviewData, PreviewCount, RemovedPreviewData } from './bodiesData';
import { acresText, type BodyRow, changedWhen, STANDING_LABEL } from './bodiesModel';
import { RECORD_FAILED, reportsSinceWords } from './listWords';
import { coordText, OutlineStill } from './OutlineStill';

/**
 * The preview pane (boards 5.1–5.3, right): the body the list has open, read before it's opened
 * in full — its outline, its lockup (class and place, the name, area, depth, elevation), its
 * reports this season and all-time, how complete its record is, what's asked of it, and what
 * changed last. One action at its foot: *Open in Body →* (⏎), to the body's console.
 *
 * Each block draws what its read returned and nothing else: a block whose read doesn't exist yet
 * (`null`) is left out, never drawn as a zero; a read on its way holds its block's shape, and a read
 * that failed says so. `undefined` is the body on its way.
 */

type BodyPreviewProps = {
  /**
   * The open body; `undefined` while it loads, `null` with none open, `'error'` if it failed, and
   * `{ unavailable }` for a body the reads can't serve (a rejected one) — with its list row, if the
   * list holds it.
   */
  data:
    | BodyPreviewData
    | null
    | undefined
    | 'error'
    | { unavailable: BodyRow | null; removed?: Loadable<RemovedPreviewData | null> | null };
  /** The instant ages are read against. */
  now: number;
  /** The router's link to the body's console (`<Link to="/admin/body/$id" … />`). */
  bodyLink?: (id: string) => ReactElement;
  /** Opens the body's console (⏎ in the pane; the route says where). */
  onOpen?: (id: string) => void;
  /** The action's words: where it opens the body. */
  openLabel?: string;
  /** Re-runs the preview's failed reads (its *Try again*). */
  onRetry?: () => void;
  /** The failed reads were tried again; their fresh answers aren't in. */
  pending?: boolean;
};

export function BodyPreview({
  data,
  now,
  bodyLink,
  onOpen,
  onRetry,
  pending = false,
  openLabel = OPEN_LABEL,
}: BodyPreviewProps) {
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
        {/* Mounted whatever the pane holds, so a failure's words are announced as they arrive. */}
        <RetryNote
          data-slot="preview-error"
          className="mt-(--space-3) empty:mt-0"
          onRetry={onRetry}
          pending={pending}
        >
          {data === 'error' ? 'Couldn’t read this body' : null}
        </RetryNote>
        {data === undefined ? (
          <PreviewLoading />
        ) : data === null ? (
          <ListEnd className="mt-(--space-3)">No body open</ListEnd>
        ) : data === 'error' ? null : 'unavailable' in data ? (
          <RowOnly
            row={data.unavailable}
            // `undefined` is the record on its way; a caller that gave none has `null`.
            removed={'removed' in data ? data.removed : null}
            now={now}
            onRetry={onRetry}
            pending={pending}
          />
        ) : (
          <PreviewBody data={data} now={now} onRetry={onRetry} pending={pending} />
        )}
      </div>
      {data != null && data !== 'error' && !('unavailable' in data) && (
        <div data-slot="preview-actbar" className="shrink-0 px-(--space-2) pb-(--space-2)">
          <div className="flex border border-solid border-line p-(--space-2)">
            {bodyLink !== undefined ? (
              // Navigation is a link (the router's), worn in the bar's button face.
              cloneElement(
                bodyLink(data.id) as ReactElement<ComponentProps<'a'>>,
                {
                  'data-slot': 'open-in-body',
                  className: cn(buttonVariants(), 'w-full no-underline'),
                  children: <OpenLabel label={openLabel} />,
                } as ComponentProps<'a'>,
              )
            ) : (
              <Button data-slot="open-in-body" className="w-full" onClick={() => onOpen?.(data.id)}>
                <OpenLabel label={openLabel} />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Where the list opens a body, in words: its Body console. */
export const OPEN_LABEL = 'Open in Body';

function OpenLabel({ label }: { label: string }) {
  return (
    <span data-slot="label" className="inline-flex items-center gap-[inherit]">
      {label} →
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
  // The town with its own state when the read says; else the bare town — never a state inferred
  // (a border body's town is in one of its states, and the read alone says which).
  const where =
    data.town !== null
      ? townWithState({ name: data.town, state: data.townState ?? null })
      : data.states.length > 0
        ? data.states.join(' · ')
        : null;
  return (
    <>
      {waterBodyClassLabel(data.bodyClass)}
      {where !== null && ` · ${where}`}
      {data.townsNotComputed === true && ' · Towns not computed yet'}
      {data.moreTowns.length > 0 && (
        <>
          {' · '}
          <Tooltip>
            <TooltipTrigger variant="text" render={<span />}>
              +{data.moreTowns.length}
            </TooltipTrigger>
            <TooltipContent>Also in: {otherTowns(data)}</TooltipContent>
          </Tooltip>
        </>
      )}
    </>
  );
}

/** Other towns the tooltip names before it counts the rest — a big lake reaches into dozens. */
export const TOOLTIP_TOWNS = 12;

/**
 * The other towns, each as the read gives it ("Canaan, NH", or bare when no state is stored — never
 * inferred). Past {@link TOOLTIP_TOWNS}, the rest are counted ("and 27 more").
 */
export function otherTowns(data: Pick<BodyPreviewData, 'moreTowns'>): string {
  const named = data.moreTowns.slice(0, TOOLTIP_TOWNS).map(townWithState).join(' · ');
  const rest = data.moreTowns.length - TOOLTIP_TOWNS;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/**
 * "9.4 / 24 m", either half alone when only one is recorded. A depth only a measured source vouches
 * for reads plainly; a modeled or unrecorded one reads as an estimate ("~8.1"), as on the console's
 * figures and Water (D3).
 */
export function depthText(
  mean: number | null,
  max: number | null,
  meanSource: DepthSource | null = null,
  maxSource: DepthSource | null = null,
): string | null {
  const figure = (m: number) => (m < 10 ? m.toFixed(1) : Math.round(m).toString());
  const sure = (source: DepthSource | null) => source !== null && isMeasuredDepthSource(source);
  const fm = (m: number) => `${sure(meanSource) ? '' : '~'}${figure(m)}`;
  const fx = (m: number) => `${sure(maxSource) ? '' : '~'}${figure(m)}`;
  if (mean !== null && max !== null) return `${fm(mean)} / ${fx(max)} m`;
  if (max !== null) return `${fx(max)} m`;
  if (mean !== null) return `${fm(mean)} m`;
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

/**
 * A body the reads can't serve — a rejected one, which `waterBodies.get` doesn't return: what its
 * list row says (name, class and states, standing, its last change), and plainly that the full
 * preview isn't shown. No way into the Body console, which can't read it either.
 */
function RowOnly({
  row,
  removed,
  now,
  onRetry,
  pending,
}: {
  row: BodyRow | null;
  removed: Loadable<RemovedPreviewData | null> | null;
  now: number;
  onRetry: (() => void) | undefined;
  pending: boolean;
}) {
  const record = loaded(removed ?? undefined) ?? null;
  // The record names it once read; until then (or without it) the list row does.
  const head =
    record !== null
      ? {
          name: record.name,
          bodyClass: record.bodyClass,
          states: record.states,
          standing: record.standing,
        }
      : row;
  const standing = head?.standing ?? null;
  return (
    <div data-slot="preview-unavailable" className="flex flex-col gap-(--space-2) pt-(--space-3_5)">
      {head !== null && (
        <>
          <span className={KICK}>
            {waterBodyClassLabel(head.bodyClass)}
            {head.states.length > 0 && ` · ${head.states.join(' · ')}`}
          </span>
          <h2
            data-slot="preview-name"
            className="m-0 text-disp leading-none font-semibold tracking-disp text-fg uppercase"
          >
            {head.name}
          </h2>
          <span className="flex items-center gap-(--space-2)">
            {standing !== null && (
              <Badge tone="dim" className="normal-case">
                {STANDING_LABEL[standing]}
              </Badge>
            )}
            {row !== null && row.changedAt !== null && (
              <span className="text-assist leading-none text-fg3">
                Last changed {changedWhen(row.changedAt, now)}
              </span>
            )}
          </span>
        </>
      )}
      <Note data-slot="preview-unavailable-note" className="mt-(--space-1)">
        {standing !== null
          ? `The full preview isn’t available for a ${STANDING_LABEL[standing].toLowerCase()} body.`
          : 'The full preview isn’t available for a body that isn’t listed.'}
      </Note>
      {removed === undefined && <SkeletonText lines={3} width="60%" className="mt-(--space-2)" />}
      {record !== null && <RecordList record={record} />}
      <RetryNote
        data-slot="preview-removed-error"
        className="mt-(--space-2) empty:mt-0"
        onRetry={onRetry}
        pending={pending}
      >
        {isFailed(removed) ? RECORD_FAILED : null}
      </RetryNote>
    </div>
  );
}

/** What a removed or rejected body's record still holds: area, how it left, towns, reports. */
function RecordList({ record }: { record: RemovedPreviewData }) {
  const left = record.left;
  return (
    <KeyValueList
      data-slot="preview-removed"
      keyWidth="5.5rem"
      className="mt-(--space-2) w-full gap-y-(--space-2_5)"
    >
      <KeyValueRow label="Area">
        {record.areaSqM === null ? (
          <span className="text-fg3">{NOT_RECORDED}</span>
        ) : (
          `${acresText(record.areaSqM)} ac`
        )}
      </KeyValueRow>
      {left !== null && (
        <KeyValueRow label={left.verb}>
          <span className="flex flex-col gap-(--space-1)">
            <span>
              {left.when}
              {left.who !== null && ` · ${left.who}`}
            </span>
            {left.because !== undefined && <span>{left.because}</span>}
            {left.reason !== null && <span className="text-fg3">“{left.reason}”</span>}
          </span>
        </KeyValueRow>
      )}
      <KeyValueRow label="Towns">
        {record.towns === null ? (
          <span className="text-fg3">{NOT_COMPUTED_WORDS}</span>
        ) : record.towns.length === 0 ? (
          <span className="text-fg3">{IN_NO_TOWN_WORDS}</span>
        ) : (
          record.towns.join(' · ')
        )}
      </KeyValueRow>
      {/* The console's words for the same count: a floor when capped, never a total. */}
      <KeyValueRow label="Reports">{reportsSinceWords(countText(record.reports))}</KeyValueRow>
    </KeyValueList>
  );
}

/** A count of reports: "3 reports", "1,000+ reports" when the read stopped short. */
function ReportsTile({ label, count }: { label: string; count: PreviewCount }) {
  return (
    <StatTile
      label={label}
      value={countText(count)}
      unit={count.count === 1 && !count.capped ? 'report' : 'reports'}
      {...(count.sub !== null && { sub: count.sub })}
    />
  );
}

function PreviewBody({
  data,
  now,
  onRetry,
  pending,
}: {
  data: BodyPreviewData;
  now: number;
  onRetry: (() => void) | undefined;
  pending: boolean;
}) {
  const depth = depthText(
    data.meanDepthM,
    data.maxDepthM,
    data.meanDepthSource ?? null,
    data.maxDepthSource ?? null,
  );
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
      {/* A failed put-ins or bays read is said, never drawn like a body that has none. */}
      <RetryNote
        data-slot="preview-marks-error"
        className="mt-(--space-3) empty:mt-0"
        onRetry={onRetry}
        pending={pending}
      >
        {data.marksError === true ? 'Put-ins and bays couldn’t be read' : null}
      </RetryNote>
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
        {data.facts === 'loading' ? (
          <StatGrid
            columns={2}
            data-slot="preview-reports"
            aria-busy="true"
            className="mt-(--space-1) border-0 border-t border-dotted border-line pt-(--space-2_5)"
          >
            <StatTile label="This season" value="" unit="reports" sub="" loading chars={2} />
            <StatTile label="All-time" value="" unit="reports" sub="" loading chars={3} />
          </StatGrid>
        ) : data.facts === 'error' ? null : (
          (data.season !== null || data.allTime !== null) && (
            <StatGrid
              columns={2}
              data-slot="preview-reports"
              className="mt-(--space-1) border-0 border-t border-dotted border-line pt-(--space-2_5)"
            >
              {data.season !== null && <ReportsTile label="This season" count={data.season} />}
              {data.allTime !== null && <ReportsTile label="All-time" count={data.allTime} />}
            </StatGrid>
          )
        )}
        <RetryNote
          data-slot="preview-facts-error"
          className="mt-(--space-2) empty:mt-0"
          onRetry={onRetry}
          pending={pending}
        >
          {data.facts === 'error' ? 'Reports, completeness and asks couldn’t be read' : null}
        </RetryNote>
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
      {data.intake != null && data.intake.length > 0 && (
        <Section title="Intake review" count={data.intake.length} className="mt-(--space-5_5)">
          <ul data-slot="preview-intake" className="m-0 flex list-none flex-col p-0">
            {data.intake.map((item) => (
              <li key={item.reason} className="flex flex-col gap-(--space-1) py-(--space-2)">
                <span className="text-body leading-list text-fg">{item.title}</span>
                {item.sub !== null && (
                  <span className="text-assist leading-list text-fg3">{item.sub}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {data.asks !== null && data.asks.length > 0 && (
        <Section
          title="Asked of this body"
          // Every open ask, a floor when the count stopped short — not the list's length.
          count={data.askCount ?? data.asks.length}
          className="mt-(--space-5_5)"
        >
          {data.asksPartial && data.askCount !== null && (
            // The list is the newest of them: said plainly, so it never reads as every ask.
            <span data-slot="preview-asks-partial" className="text-assist leading-list text-fg3">
              Newest {data.asks.length.toLocaleString('en-US')} of {countText(data.askCount)}
            </span>
          )}
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
      <RetryNote
        data-slot="preview-history-error"
        className="mt-(--space-5_5) empty:mt-0"
        onRetry={onRetry}
        pending={pending}
      >
        {data.history === 'error' ? 'Couldn’t read the history' : null}
      </RetryNote>
      {data.history === 'error'
        ? null
        : data.history !== null && (
            <Section
              title="Last changed"
              // The newest of more when the read stopped short: a floor ("7+"), never the whole.
              count={{ count: data.history.length, capped: data.historyCapped === true }}
              className="mt-(--space-5_5)"
            >
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
