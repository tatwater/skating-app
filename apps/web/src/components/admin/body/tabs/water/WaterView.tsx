import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLink } from '@fortawesome/sharp-regular-svg-icons';
import type { DepthSource } from '@skating/core';
import { type ReactNode, useState } from 'react';
import { isFailed, type Loadable } from '@/components/admin/reads/consoleReads';
import { Button } from '@/components/kit/button';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Input, InputGroup, InputGroupIcon, InputGroupKbd } from '@/components/kit/input';
import { RadioGroup } from '@/components/kit/radio';
import { RadioCell } from '@/components/kit/radio-cell';
import { Section } from '@/components/kit/section-slug';
import { UnavailableButton } from '@/components/kit/unavailable-button';
import { UnavailableField } from '@/components/kit/unavailable-field';
import { cn } from '@/lib/utils';
import { LIT_ROW, LoadingSection, litAttr, TabBody, useDraft } from '../tabParts';
import { CouldntRead, LoadingLine, NOT_RECORDED, ReadFailures } from '../tabStates';
import {
  type DepthRung,
  depthFigure,
  formatLatLng,
  isEstimate,
  litId,
  samplingNote,
  sourceWords,
  type WaterData,
} from './waterModel';

/**
 * Body › Water (board 5.4.5), the default view: depth as a ladder of sources — the mean and the max
 * each a column of choices, the value in use wearing Now — where the weather is sampled and why
 * there, and the bathymetry state, the section's chip amber while the record lacks it.
 *
 * Every control is drawn only when its handler is passed. Choosing a depth source and filing a
 * survey wait on their server writes: for a viewer who could make them (`canChooseDepth`,
 * `canFileSurvey`) each is drawn where the board draws it and says *Not available yet*. The
 * sample-point preview is a map mode, not built. What no read records says *Not recorded yet*.
 */

/** What the unbuilt controls will do, in the operator's words. */
const NOT_YET = {
  depth: 'Choosing which source a depth comes from comes with the depth editor.',
  survey: 'Filing a survey for the next bathymetry build comes with the survey queue.',
};

export type WaterViewProps = {
  /** The tab's data; `undefined` while it loads, `failed` when the record couldn't be read. */
  data: Loadable<WaterData>;
  /** Ask again for every read that failed. */
  onRetry?: () => void;
  /** Tried again; the fresh answers aren't in. */
  retryPending?: boolean;
  lit?: string | null;
  /** Use this source's number for the mean or the max. */
  onChooseDepth?: (measurement: 'mean' | 'max', source: DepthSource) => void;
  /** File a survey the next bathymetry build should load (a link or a citation). */
  onSurvey?: (text: string) => void;
  /** The link to Machinery's enrichment page, once it exists. */
  enrichmentLink?: ReactNode;
  /** The viewer could choose a depth's source: with no `onChooseDepth` yet, it says so. */
  canChooseDepth?: boolean;
  /** The viewer could file a survey: with no `onSurvey` yet, the field says so. */
  canFileSurvey?: boolean;
};

/**
 * The ladder's row heights: the boards' 36 px row (a 26 px cell, 5 px over and under) and 52 px
 * with a source's note. No size token holds either; named here so the token lands in one place.
 */
const ROW = 'h-[2.25rem]';
const ROW_NOTED = 'h-[3.25rem]';
/** The mean and max columns: the boards' 106 px (a 100 px cell and its 6 px lead). */
const VALUE_COLUMN = 'w-[6.625rem]';

const HEAD = 'text-kick leading-none font-medium tracking-kick text-fg3 uppercase';

export function WaterView({
  data,
  onRetry,
  retryPending = false,
  lit = null,
  onChooseDepth,
  onSurvey,
  enrichmentLink,
  canChooseDepth = false,
  canFileSurvey = false,
}: WaterViewProps) {
  if (data === undefined) {
    return (
      <TabBody aria-busy="true" data-slot="water-tab">
        <LoadingSection lines={4} />
        <LoadingSection lines={4} />
        <LoadingSection lines={3} />
      </TabBody>
    );
  }
  if (isFailed(data)) {
    return (
      <TabBody data-slot="water-tab">
        <ReadFailures
          failures={[]}
          whole="Couldn’t read this body’s record."
          onRetry={onRetry}
          pending={data.pending}
        />
      </TabBody>
    );
  }
  return (
    <TabBody data-slot="water-tab">
      <ReadFailures failures={data.failures} onRetry={onRetry} pending={retryPending} />
      <DepthSection data={data} lit={lit} onChoose={onChooseDepth} canChoose={canChooseDepth} />
      <SamplingSection data={data} lit={lit} />
      <BathymetrySection
        data={data}
        onSurvey={onSurvey}
        canSurvey={canFileSurvey}
        enrichmentLink={enrichmentLink}
      />
    </TabBody>
  );
}

function DepthSection({
  data,
  lit,
  onChoose,
  canChoose,
}: {
  data: WaterData;
  lit: string | null;
  onChoose: WaterViewProps['onChooseDepth'];
  canChoose: boolean;
}) {
  const { rungs, meanFrom, maxFrom, others } = data.depth;
  // A viewer who could choose picks a cell either way; with no write yet, the button says so.
  const picks = onChoose !== undefined || canChoose;
  // Back on the record's sources whenever they move, so a pick never outlives the value it left.
  const [mean, setMean] = useDraft<DepthSource | null>(meanFrom);
  const [max, setMax] = useDraft<DepthSource | null>(maxFrom);
  const height = (r: DepthRung) =>
    sourceWords(r.source, data.state, data.depthNote).note !== null ? ROW_NOTED : ROW;
  const rule = 'border-0 border-b border-dotted border-line last:border-b-0';

  const column = (
    measurement: 'mean' | 'max',
    pick: DepthSource | null,
    setPick: (s: DepthSource) => void,
    now: DepthSource | null,
  ) => (
    <RadioGroup
      aria-label={measurement === 'mean' ? 'Mean depth' : 'Max depth'}
      value={pick}
      readOnly={!picks}
      onValueChange={(v) => setPick(v as DepthSource)}
      data-slot={`depth-${measurement}`}
      className={cn('shrink-0', VALUE_COLUMN)}
    >
      {rungs.map((r) => {
        const value = r[measurement];
        return (
          <div
            key={r.source}
            className={cn('flex items-start py-(--space-1_5) pl-(--space-1_5)', height(r), rule)}
          >
            {value !== null && (
              <RadioCell
                value={r.source}
                figure={depthFigure(value)}
                unit="m"
                estimate={isEstimate(r.source)}
                now={now === r.source}
                aria-label={`${sourceWords(r.source, data.state, data.depthNote).name}, ${depthFigure(value)} m`}
              />
            )}
          </div>
        );
      })}
    </RadioGroup>
  );

  return (
    <Section title="Depth" data-slot="depth">
      {rungs.length === 0 ? (
        <span className="text-assist leading-list text-fg3">No depth on record</span>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-end border-0 border-b border-solid border-line2 pb-(--space-2)">
            <span className={cn(HEAD, 'flex-1')}>Source</span>
            <span className={cn(HEAD, VALUE_COLUMN, 'pr-(--space-2) text-right')}>Mean</span>
            <span className={cn(HEAD, VALUE_COLUMN, 'pr-(--space-2) text-right')}>Max</span>
          </div>
          <div className="flex">
            <ul className="flex min-w-0 flex-1 flex-col">
              {rungs.map((r, i) => {
                const words = sourceWords(r.source, data.state, data.depthNote);
                return (
                  <li
                    key={r.source}
                    data-slot="depth-source"
                    {...litAttr(lit, litId.depth(r.source))}
                    className={cn(
                      'flex flex-col justify-start py-(--space-1_5)',
                      height(r),
                      rule,
                      LIT_ROW,
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-btn-sm items-center truncate text-row',
                        i === 0 ? 'text-fg' : 'text-fg1',
                      )}
                    >
                      {words.name}
                    </span>
                    {words.note !== null && (
                      // A moderator's note runs to 160 characters: kept to its row, never over the
                      // figures beside it, and whole on hover (clipped across only, so the tight
                      // leading never cuts a descender).
                      <span
                        title={words.note}
                        className="overflow-x-clip text-ellipsis whitespace-nowrap text-assist leading-none text-fg3"
                      >
                        {words.note}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {column('mean', mean, setMean, meanFrom)}
            {column('max', max, setMax, maxFrom)}
          </div>
          {picks && (mean !== meanFrom || max !== maxFrom) && (
            <div className="mt-(--space-2_5) flex flex-wrap gap-(--space-2)">
              {mean !== null && mean !== meanFrom && (
                <ChooseButton onChoose={onChoose} measurement="mean" source={mean}>
                  Use {sourceWords(mean, data.state).name} for the mean
                </ChooseButton>
              )}
              {max !== null && max !== maxFrom && (
                <ChooseButton onChoose={onChoose} measurement="max" source={max}>
                  Use {sourceWords(max, data.state).name} for the max
                </ChooseButton>
              )}
            </div>
          )}
          {others === null && (
            <span
              data-slot="depth-others"
              className="mt-(--space-2_5) text-assist leading-list text-fg3"
            >
              Other sources’ depths: {NOT_RECORDED}
            </span>
          )}
        </div>
      )}
    </Section>
  );
}

/** Apply a picked source — or, with no write yet, say it isn't available. */
function ChooseButton({
  onChoose,
  measurement,
  source,
  children,
}: {
  onChoose: WaterViewProps['onChooseDepth'];
  measurement: 'mean' | 'max';
  source: DepthSource;
  children: ReactNode;
}) {
  return onChoose ? (
    <Button size="sm" onClick={() => onChoose(measurement, source)}>
      {children}
    </Button>
  ) : (
    <UnavailableButton size="sm" what={NOT_YET.depth}>
      {children}
    </UnavailableButton>
  );
}

function SamplingSection({ data, lit }: { data: WaterData; lit: string | null }) {
  const { sampling } = data;
  const note = samplingNote(data.name, sampling);
  const mono = 'font-(family-name:--family-mono) text-mono-sm font-medium text-fg';
  return (
    <Section
      title={
        sampling.points !== null && sampling.points.length > 1
          ? 'Weather sample points'
          : 'Weather sample point'
      }
      data-slot="sampling"
    >
      <KeyValueList keyWidth="6.5rem">
        {sampling.points !== null ? (
          <KeyValueRow label="Points">
            <span className="flex flex-col gap-(--space-1)">
              {sampling.points.map((p, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: a grid point is its place in the grid
                  key={i}
                  {...litAttr(lit, litId.point(i))}
                  className={cn(mono, LIT_ROW)}
                >
                  {formatLatLng(p)}
                </span>
              ))}
              <span className="text-fg3">Set by hand, in place of the interior point</span>
            </span>
          </KeyValueRow>
        ) : sampling.interior !== null ? (
          <KeyValueRow label="Point" {...litAttr(lit, litId.interior)} className={LIT_ROW}>
            <span className="flex flex-col gap-(--space-1)">
              <span>Interior point</span>
              <span className={mono}>{formatLatLng(sampling.interior)}</span>
              <span className="text-fg3">
                Worked out from the outline: inside the water, near its middle
              </span>
            </span>
          </KeyValueRow>
        ) : null}
        <KeyValueRow label="Forecast">
          Open-Meteo, for the model cell the point falls in
        </KeyValueRow>
      </KeyValueList>
      {note !== null && <p className="text-assist leading-(--lead-list) text-fg3">{note}</p>}
    </Section>
  );
}

function BathymetrySection({
  data,
  onSurvey,
  canSurvey,
  enrichmentLink,
}: {
  data: WaterData;
  canSurvey: boolean;
} & Pick<WaterViewProps, 'onSurvey' | 'enrichmentLink'>) {
  const [draft, setDraft] = useState('');
  const b = data.bathymetry;
  const missing = typeof b === 'object' && !isFailed(b) && b.missing;
  const field = (disabled: boolean) => (
    <InputGroup>
      <InputGroupIcon>
        <FontAwesomeIcon icon={faLink} />
      </InputGroupIcon>
      <Input
        aria-label="A survey the next build should load"
        placeholder="Paste a link or a citation"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
      />
      <InputGroupKbd>⏎</InputGroupKbd>
    </InputGroup>
  );
  return (
    <Section
      title="Bathymetry"
      data-slot="bathymetry"
      data-gap={missing ? '' : undefined}
      aria-busy={b === undefined || undefined}
      // The one gap left on the record turns the title chip amber (Review 14).
      tone={missing ? 'warn' : 'default'}
      end={enrichmentLink}
    >
      {b === undefined ? (
        <span aria-hidden="true" className="flex flex-col gap-(--space-1_5)">
          <LoadingLine width="100%" />
          <LoadingLine width="70%" />
        </span>
      ) : isFailed(b) ? (
        <CouldntRead />
      ) : (
        <KeyValueList keyWidth="6.5rem">
          <KeyValueRow label="Searched">
            {b.searched !== null ? (
              <span className="flex flex-col gap-(--space-1)">
                <span>{b.searched.source}</span>
                <span className="text-fg3">{b.searched.when}</span>
              </span>
            ) : (
              <span className="text-fg3">{NOT_RECORDED}</span>
            )}
          </KeyValueRow>
          <KeyValueRow label="Found">{b.found}</KeyValueRow>
        </KeyValueList>
      )}
      {onSurvey ? (
        <form
          className="mt-(--space-1_5) flex flex-col gap-(--space-2)"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (text === '') return;
            onSurvey(text);
            setDraft('');
          }}
        >
          <span className={HEAD}>A survey the next build should load</span>
          {field(false)}
        </form>
      ) : (
        canSurvey && (
          <div className="mt-(--space-1_5) flex flex-col gap-(--space-2)">
            <span className={HEAD}>A survey the next build should load</span>
            <UnavailableField what={NOT_YET.survey} label="A survey the next build should load">
              {field(true)}
            </UnavailableField>
          </div>
        )
      )}
    </Section>
  );
}
