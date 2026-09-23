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
import { Button } from '../ui/button';
import { Input } from '../ui/input';
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
    <div className="flex flex-col gap-2.5 rounded-[2px] border border-border bg-background p-2.5">
      <div className="flex gap-2">
        <label
          htmlFor={`${id}-tempF`}
          className="flex flex-1 flex-col gap-1 text-foreground-muted text-xs"
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
          className="flex flex-1 flex-col gap-1 text-foreground-muted text-xs"
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
          className="flex flex-1 flex-col gap-1 text-foreground-muted text-xs"
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
      <div className="flex flex-wrap gap-2">
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
      <div className="flex flex-wrap gap-2">
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
      </div>
      <Button size="sm" variant="outline" className="self-start" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
