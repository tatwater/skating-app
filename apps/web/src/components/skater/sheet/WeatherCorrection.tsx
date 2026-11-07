import {
  cToF,
  fToC,
  kphToMph,
  mphToKph,
  PRECIP_LABELS,
  PRECIP_TYPES,
  type ReportConditionsInput,
  roundTo,
  SKY_CONDITIONS,
  SKY_LABELS,
} from '@skating/core';
import { useId, useState } from 'react';
import { Button } from '@/components/kit/button';
import { Input } from '@/components/kit/input';
import { SheetChip } from './SheetChip';

/**
 * The weather, corrected by the author (founder call, 2026-09-21): the archive's hour is the
 * starting point, the author changes what they saw, and the block stores as `source: 'user'` — a
 * person's observation over a model's, the rule the autofill has always kept.
 */
export function WeatherCorrection({
  initial,
  onChange,
  onDone,
}: {
  initial: ReportConditionsInput;
  onChange: (next: ReportConditionsInput) => void;
  onDone: () => void;
}) {
  const id = useId();
  const [tempF, setTempF] = useState(
    initial.airTempC === undefined ? '' : String(roundTo(cToF(initial.airTempC), 0)),
  );
  const [windMph, setWindMph] = useState(
    initial.windSpeedKph === undefined ? '' : String(roundTo(kphToMph(initial.windSpeedKph), 0)),
  );
  const [windDir, setWindDir] = useState(initial.windDir ?? '');
  const [sky, setSky] = useState(initial.sky);
  const [precip, setPrecip] = useState(initial.precip);

  const emit = (patch: {
    tempF?: string;
    windMph?: string;
    windDir?: string;
    sky?: ReportConditionsInput['sky'];
    precip?: ReportConditionsInput['precip'];
  }) => {
    const t = patch.tempF ?? tempF;
    const w = patch.windMph ?? windMph;
    const d = patch.windDir ?? windDir;
    const s = 'sky' in patch ? patch.sky : sky;
    const p = 'precip' in patch ? patch.precip : precip;
    const num = (v: string) =>
      v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
    onChange({
      ...(num(t) !== undefined ? { airTempC: fToC(num(t) as number) } : {}),
      ...(num(w) !== undefined ? { windSpeedKph: mphToKph(num(w) as number) } : {}),
      ...(d.trim() ? { windDir: d.trim().toUpperCase() } : {}),
      ...(s !== undefined ? { sky: s } : {}),
      ...(p !== undefined ? { precip: p } : {}),
      source: 'user',
    });
  };

  return (
    <div
      data-slot="weather-correction"
      className="flex flex-col gap-(--space-2_5) border border-solid border-line2 bg-panel p-(--space-3)"
    >
      <div className="flex gap-(--space-2)">
        <label
          htmlFor={`${id}-tempF`}
          className="flex flex-1 flex-col gap-(--space-1) text-kick leading-none font-medium tracking-head text-fg3 uppercase"
        >
          Air °F
          <Input
            id={`${id}-tempF`}
            inputMode="decimal"
            value={tempF}
            onChange={(e) => {
              setTempF(e.target.value);
              emit({ tempF: e.target.value });
            }}
          />
        </label>
        <label
          htmlFor={`${id}-windMph`}
          className="flex flex-1 flex-col gap-(--space-1) text-kick leading-none font-medium tracking-head text-fg3 uppercase"
        >
          Wind mph
          <Input
            id={`${id}-windMph`}
            inputMode="decimal"
            value={windMph}
            onChange={(e) => {
              setWindMph(e.target.value);
              emit({ windMph: e.target.value });
            }}
          />
        </label>
        <label
          htmlFor={`${id}-windDir`}
          className="flex flex-1 flex-col gap-(--space-1) text-kick leading-none font-medium tracking-head text-fg3 uppercase"
        >
          From
          <Input
            id={`${id}-windDir`}
            placeholder="NW"
            value={windDir}
            onChange={(e) => {
              setWindDir(e.target.value);
              emit({ windDir: e.target.value });
            }}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-(--space-1_5)">
        {SKY_CONDITIONS.map((s) => (
          <SheetChip
            key={s}
            compact
            label={SKY_LABELS[s]}
            {...(sky === s ? { tier: 'solid' as const } : {})}
            onClick={() => {
              const next = sky === s ? undefined : s;
              setSky(next);
              emit({ sky: next });
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-(--space-1_5)">
        {PRECIP_TYPES.map((p) => (
          <SheetChip
            key={p}
            compact
            label={PRECIP_LABELS[p]}
            {...(precip === p ? { tier: 'solid' as const } : {})}
            onClick={() => {
              const next = precip === p ? undefined : p;
              setPrecip(next);
              emit({ precip: next });
            }}
          />
        ))}
        <Button size="sm" className="ml-auto" data-attr="weather-correct-done" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
