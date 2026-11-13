import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLink } from '@fortawesome/sharp-regular-svg-icons';
import type { DepthSource } from '@skating/core';
import { type ReactNode, useState } from 'react';

import { Button } from '@/components/kit/button';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Input, InputGroup, InputGroupIcon, InputGroupKbd } from '@/components/kit/input';
import { RadioGroup } from '@/components/kit/radio';
import { Section } from '@/components/kit/section-slug';
import { cn } from '@/lib/utils';

import { LIT_ROW, LoadingSection, litAttr, TabBody } from '../names/tabParts';
import { RadioCell } from './kit-candidates/radio-cell';
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
 * survey wait on their server writes; the sample-point preview is a map mode, not built.
 */

export type WaterViewProps = {
  data: WaterData | undefined;
  lit?: string | null;
  /** Use this source's number for the mean or the max. */
  onChooseDepth?: (measurement: 'mean' | 'max', source: DepthSource) => void;
  /** File a survey the next bathymetry build should load (a link or a citation). */
  onSurvey?: (text: string) => void;
  /** The link to Machinery's enrichment page, once it exists. */
  enrichmentLink?: ReactNode;
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
  lit = null,
  onChooseDepth,
  onSurvey,
  enrichmentLink,
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
  return (
    <TabBody data-slot="water-tab">
      <DepthSection data={data} lit={lit} onChoose={onChooseDepth} />
      <SamplingSection data={data} lit={lit} />
      <BathymetrySection data={data} onSurvey={onSurvey} enrichmentLink={enrichmentLink} />
    </TabBody>
  );
}

function DepthSection({
  data,
  lit,
  onChoose,
}: {
  data: WaterData;
  lit: string | null;
  onChoose: WaterViewProps['onChooseDepth'];
}) {
  const { rungs, meanFrom, maxFrom } = data.depth;
  const [mean, setMean] = useState<DepthSource | null>(meanFrom);
  const [max, setMax] = useState<DepthSource | null>(maxFrom);
  const height = (r: DepthRung) =>
    sourceWords(r.source, data.state).note !== null ? ROW_NOTED : ROW;
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
      readOnly={!onChoose}
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
                aria-label={`${sourceWords(r.source, data.state).name}, ${depthFigure(value)} m`}
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
                const words = sourceWords(r.source, data.state);
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
                      <span className="text-assist leading-none whitespace-nowrap text-fg3">
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
          {onChoose && (mean !== meanFrom || max !== maxFrom) && (
            <div className="mt-(--space-2_5) flex flex-wrap gap-(--space-2)">
              {mean !== null && mean !== meanFrom && (
                <Button size="sm" onClick={() => onChoose('mean', mean)}>
                  Use {sourceWords(mean, data.state).name} for the mean
                </Button>
              )}
              {max !== null && max !== maxFrom && (
                <Button size="sm" onClick={() => onChoose('max', max)}>
                  Use {sourceWords(max, data.state).name} for the max
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
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
  enrichmentLink,
}: {
  data: WaterData;
} & Pick<WaterViewProps, 'onSurvey' | 'enrichmentLink'>) {
  const [draft, setDraft] = useState('');
  const b = data.bathymetry;
  return (
    <Section
      title="Bathymetry"
      data-slot="bathymetry"
      data-gap={b?.missing ? '' : undefined}
      // The one gap left on the record turns the title chip amber (Review 14). The kit's slug has
      // no tone yet (a kit extension owed); until it does, the chip is toned from here.
      className="data-gap:[&_[data-slot=section-chip]]:bg-warn data-gap:[&_[data-slot=section-chip]]:text-bg"
      end={enrichmentLink}
    >
      {b === null ? (
        <span className="text-assist leading-list text-fg3">Not recorded yet</span>
      ) : (
        <KeyValueList keyWidth="6.5rem">
          {b.searched !== null && (
            <KeyValueRow label="Searched">
              <span className="flex flex-col gap-(--space-1)">
                <span>{b.searched.source}</span>
                <span className="text-fg3">{b.searched.when}</span>
              </span>
            </KeyValueRow>
          )}
          <KeyValueRow label="Found">{b.found}</KeyValueRow>
        </KeyValueList>
      )}
      {onSurvey && (
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
          <InputGroup>
            <InputGroupIcon>
              <FontAwesomeIcon icon={faLink} />
            </InputGroupIcon>
            <Input
              aria-label="A survey the next build should load"
              placeholder="Paste a link or a citation"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <InputGroupKbd>⏎</InputGroupKbd>
          </InputGroup>
        </form>
      )}
    </Section>
  );
}
