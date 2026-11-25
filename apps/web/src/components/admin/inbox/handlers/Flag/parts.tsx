import type { ComponentProps, ReactNode } from 'react';
import { ClaimChip } from '@/components/kit/claim-chip';
import { FactList } from '@/components/kit/fact-list';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { StatGrid, StatTile } from '@/components/kit/stat-tile';
import { ComingSoonLink } from '@/components/kit/unavailable-button';
import { cn } from '@/lib/utils';
import { countWords } from './flagFormat';
import { type ClaimChip as ClaimChipData, thumbsOf, weatherCells } from './flagModel';
import type { ClaimWeatherData } from './flagTypes';
import { FLAG_WORDS as W } from './flagWords';

/**
 * The small pieces every flag subject is built from: the subject's title, the claims as chips, *That
 * night, at the body*, *Also on this report*. Props only.
 */

/** The kicker over a subject's display title ("Report · Enfield, NH · …" over "Mascoma Lake"). */
export function SubjectTitle({
  kicker,
  title,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & { kicker: string; title: ReactNode }) {
  return (
    <div
      data-slot="subject-title"
      className={cn('flex min-w-0 flex-col gap-(--space-2_5)', className)}
      {...props}
    >
      <span
        data-slot="subject-kicker"
        className="truncate text-kick leading-none font-semibold tracking-kick text-fg3 uppercase"
      >
        {kicker}
      </span>
      <h3
        data-slot="subject-name"
        // The boards' 20 px title at .08em: no tracking step there (rail's .1em is nearest; reported).
        className="m-0 truncate text-disp leading-none font-semibold tracking-rail text-fg uppercase"
      >
        {title}
      </h3>
    </div>
  );
}

/** The subject's own words (a report's notes, a comment, an alert's note). */
export function SubjectText({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="subject-text"
      className={cn('m-0 text-row leading-body text-fg1', className)}
      {...props}
    />
  );
}

/** The claims as the report states them — hairline chips, the claim under question in red. */
export function ClaimChips({ chips }: { chips: readonly ClaimChipData[] }) {
  if (chips.length === 0) return null;
  return (
    <ul data-slot="claim-chips" className="m-0 flex list-none flex-wrap gap-(--space-1_5) p-0">
      {chips.map((c) => (
        <li key={c.key} className="contents">
          <ClaimChip tone={c.flagged ? 'bad' : 'default'} data-flagged={c.flagged ? '' : undefined}>
            {c.label}
          </ClaimChip>
        </li>
      ))}
    </ul>
  );
}

/** A sub-heading inside a subject (`.subhd`). */
export function SubHead({ className, ...props }: ComponentProps<'h4'>) {
  return (
    <h4
      data-slot="sub-head"
      className={cn('m-0 text-row leading-snug font-medium text-fg1', className)}
      {...props}
    />
  );
}

/** What the weather read came to: its answer, *Not recorded yet* (`null`), or still on its way. */
export type WeatherState = ClaimWeatherData | null | 'loading' | 'failed';

/**
 * ***That night, at the body*** (2.1): the night's low, the freezing nights in a row, the freezing
 * degree-days since 1 October, and the **Stefan thickness estimate** — labeled as the model's
 * figure it is, with the link to the page that will explain the function (Coming soon). Context
 * beside the claim, never a verdict (D3, D288): no cell is compared with the claim, and a missing
 * input says what is missing.
 */
/** A read's way back: *Try again*, and whether a second try is on its way. */
export type Retry = { onRetry?: (() => void) | undefined; retrying?: boolean | undefined };

export function ClaimWeather({
  weather,
  onRetry,
  retrying = false,
}: { weather: WeatherState } & Retry) {
  return (
    <section data-slot="claim-weather" className="flex flex-col gap-(--space-2)">
      <SubHead>{W.thatNight}</SubHead>
      {/* A failed read says it failed and offers *Try again* — never "not recorded", which would
          read as no weather existing. The region stays mounted so its words are announced. */}
      <RetryNote data-slot="claim-weather-failed" onRetry={onRetry} pending={retrying}>
        {weather === 'failed' ? W.weatherFailed : undefined}
      </RetryNote>
      {weather === 'failed' ? null : weather === 'loading' ? (
        <span data-slot="claim-weather-state" className="text-assist leading-list text-fg3">
          {W.weatherLoading}
        </span>
      ) : weather === null ? (
        <Note data-slot="claim-weather-missing">
          <strong>{W.weatherMissing}</strong>
          <span className="block">{W.weatherMissingSub}</span>
        </Note>
      ) : (
        <>
          <StatGrid columns={2} ruled={false} className="gap-x-(--space-6) gap-y-(--space-4_5)">
            {weatherCells(weather).map((cell) => (
              <StatTile
                key={cell.key}
                data-slot={`weather-${cell.key}`}
                label={cell.label}
                value={cell.value ?? cell.missing ?? ''}
                {...(cell.value !== null && cell.unit !== null && { unit: cell.unit })}
                {...(cell.value === null && { tone: 'dim' as const })}
                {...(cell.note !== undefined && {
                  sub: <span data-slot={`weather-${cell.key}-note`}>{cell.note}</span>,
                })}
                {...(cell.key === 'stefan' && {
                  sub: (
                    <span className="flex flex-col items-start gap-(--space-1_5)">
                      <span data-slot="stefan-sub">{W.stefanSub}</span>
                      {/* Narrow, the stat's column is narrower than the link: it wraps in place,
                          under the figure, rather than run past its cell. */}
                      <ComingSoonLink
                        data-slot="stefan-how"
                        className="h-auto max-w-full py-(--space-1) text-start whitespace-normal"
                      >
                        {W.stefanHow}
                      </ComingSoonLink>
                    </span>
                  ),
                })}
                // A missing figure is said in words, a step down, and wraps in its cell: a figure
                // never breaks, but *Too much thaw in the last 60 days for the estimate* has to.
                className={
                  cell.value === null
                    ? '[&_[data-slot=value]]:text-row [&_[data-slot=value]]:leading-list [&_[data-slot=value]]:whitespace-normal'
                    : undefined
                }
              />
            ))}
          </StatGrid>
          <span data-slot="weather-context" className="text-assist leading-list text-fg3">
            {W.weatherContext}
          </span>
        </>
      )}
    </section>
  );
}

/** *Also on this report*: thumbs, up then down — down in amber only when it leads. */
export function AlsoOnReport({
  ratings,
  corroborations,
}: {
  ratings: { up: number; down: number } | null;
  /** Other skaters' reports that agreed with it, counted (who isn't stored, so none is named). */
  corroborations: { count: number; capped: boolean };
}) {
  const thumbs = thumbsOf(ratings);
  const agreed = corroborations.count > 0 || corroborations.capped;
  if (thumbs === null && !agreed) return null;
  const rows = [];
  if (agreed) {
    rows.push({
      label: W.corrob,
      value: (
        <span data-slot="corroborations">
          {W.corroborated(
            countWords(corroborations),
            corroborations.count === 1 && !corroborations.capped,
          )}
        </span>
      ),
    });
  }
  return (
    <div data-slot="also-on" className="flex flex-col gap-(--space-2) pt-(--space-1)">
      <SubHead>{W.alsoOn}</SubHead>
      <FactList
        rows={[
          ...(thumbs === null
            ? []
            : [
                {
                  label: W.thumbs,
                  value: (
                    <span data-slot="thumbs">
                      {thumbs.up} ·{' '}
                      <span
                        data-slot="thumbs-down"
                        className={thumbs.downLeads ? 'text-warn' : undefined}
                      >
                        {thumbs.down}
                      </span>
                    </span>
                  ),
                },
              ]),
          ...rows,
        ]}
      />
    </div>
  );
}
