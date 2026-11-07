import {
  cmToInches,
  describeWhere,
  formatThicknessReading,
  inchesToCm,
  roundTo,
  sectionSummary,
  THICKNESS_BAND_LABELS,
  THICKNESS_BANDS,
  THICKNESS_METHOD_LABELS,
  THICKNESS_METHODS,
  type ThicknessMethod,
  type ThicknessReadingInput,
  type ThicknessScope,
  thicknessBandOfKey,
  type Where,
} from '@skating/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConsoleMode } from './ConsoleMode';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetPanel, SubLabel } from './SheetPanel';
import type { SectionProps } from './sectionProps';
import { WhereCards } from './WhereCards';

const SCOPE_LABELS: Record<ThicknessScope, string> = {
  everywhere_tested: 'Everywhere I tested',
  at_spot: 'At this spot',
};

/**
 * *Thickness* (A10 / D195). The quick path first — *under 2 / 2–3 / 3–4 / 4–6 / 6+* — with a
 * scope; the precise path underneath: a number or a range in inches, measured or estimated or a
 * poke count, a lower bound alone ("at least 4"), the skater's own *held me* / *didn't hold* word,
 * and a where per reading. The word is the skater's, never ours (D3).
 */
export function ThicknessPanel({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const chips = sheet.fields.thickness.chips;
  const band = chips.map((c) => thicknessBandOfKey(c.key)).find((b) => b !== null) ?? null;
  const precise = chips.filter((c) => thicknessBandOfKey(c.key) === null && c.tier !== 'ghost');
  // The reading being typed, by the key it will be stored under: minted when *+ A measurement* is
  // clicked, so the fresh editor stays the same editor from the first digit to the last.
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [whereFor, setWhereFor] = useState<string | null>(null);
  const scope = sheet.scalars.thicknessScope;
  const nextKey = () => {
    let n = 1;
    while (chips.some((c) => c.key === `reading:${n}`)) n++;
    return `reading:${n}`;
  };
  const adding = addingKey === null ? null : (precise.find((c) => c.key === addingKey) ?? null);
  // A where chosen on the fresh editor before its first digit: there is no chip to hold it yet.
  const [pendingWhere, setPendingWhere] = useState<Where | undefined>(undefined);
  const freshReading: ThicknessReadingInput = adding?.value ?? {
    method: 'measured',
    ...(pendingWhere !== undefined ? { where: pendingWhere } : {}),
  };
  const setWhere = (key: string, where: Where | undefined) =>
    dispatch({
      type: 'setWhere',
      field: 'thickness',
      key,
      ...(where !== undefined ? { where } : {}),
    });

  // One where question open at a time, for a reading still on the sheet: a reading that goes takes
  // its question, and with it the console's mode — and forgets it, so a later reading minted under
  // the same key does not open on its own.
  const { instrument } = useConsoleMode();
  const openKey =
    whereFor !== null && (whereFor === addingKey || precise.some((c) => c.key === whereFor))
      ? whereFor
      : null;
  if (whereFor !== null && openKey === null) setWhereFor(null);
  const bayNames = Object.fromEntries((body?.bays ?? []).map((b) => [b.id, b.name]));
  /**
   * A reading's place: where the author measured (never a recommendation, D3). Closed, a chip that
   * names it; open, the same where card the ice and the sightings use, so the instrument takes the
   * click — a sector on the ring, a point on the water — for this reading alone.
   */
  const placeOf = (
    key: string,
    reading: ThicknessReadingInput,
    onChange: (where: Where | undefined) => void,
  ) =>
    openKey === key ? (
      <>
        <WhereCards
          cards={[
            {
              id: `thickness:${key}`,
              label: readingLabel(reading),
              question: 'Where did you measure?',
              where: reading.where,
              onChange,
            },
          ]}
          body={body}
          open
          onClose={() => setWhereFor(null)}
          activeId={`thickness:${key}`}
          onActivate={() => {}}
        />
        {instrument || body?.silhouette ? null : (
          <SheetHint>A point on the lake is placed on the map, on a wider screen.</SheetHint>
        )}
      </>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <SubLabel>Where did you measure?</SubLabel>
        <SheetChip
          compact
          label={placeLabel(reading.where, bayNames, instrument)}
          {...(reading.where ? { tier: 'solid' as const } : {})}
          onClick={() => setWhereFor(key)}
        />
      </div>
    );

  return (
    <SheetPanel
      label="Thickness"
      summary={sectionSummary(sheet, 'thickness', timeZone)}
      collapsed={sheet.collapsed.thickness}
      onToggle={() =>
        dispatch({
          type: 'setCollapsed',
          section: 'thickness',
          collapsed: !sheet.collapsed.thickness,
        })
      }
      gap={gaps.has('thickness')}
    >
      <div className="flex flex-wrap gap-1.5">
        {THICKNESS_BANDS.map((b) => (
          <SheetChip
            key={b}
            label={THICKNESS_BAND_LABELS[b]}
            {...(band === b ? { tier: 'solid' as const } : {})}
            onClick={() => dispatch({ type: 'selectThicknessBand', band: band === b ? null : b })}
          />
        ))}
        <SheetChip
          label="Didn't check"
          {...(band === null && precise.length === 0 && sheet.fields.thickness.touched
            ? { tier: 'solid' as const }
            : {})}
          onClick={() => dispatch({ type: 'selectThicknessBand', band: null })}
        />
      </div>
      {band !== null || precise.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(SCOPE_LABELS) as ThicknessScope[]).map((s) => (
            <SheetChip
              key={s}
              compact
              label={SCOPE_LABELS[s]}
              {...(scope === s ? { tier: 'solid' as const } : {})}
              onClick={() =>
                dispatch({
                  type: 'setScalar',
                  key: 'thicknessScope',
                  value: scope === s ? undefined : s,
                })
              }
            />
          ))}
        </div>
      ) : null}

      {precise.map((chip) => {
        if (chip.key === addingKey) return null; // drawn below, as the editor that is typing it
        const r = chip.value;
        return (
          <div
            key={chip.key}
            className="flex flex-col gap-2 rounded-[2px] border border-border bg-background p-2.5"
          >
            <ReadingEditor
              reading={r}
              onChange={(next) =>
                dispatch({ type: 'select', field: 'thickness', key: chip.key, value: next })
              }
              onRemove={() => dispatch({ type: 'deselect', field: 'thickness', key: chip.key })}
            />
            {placeOf(chip.key, r, (where) => setWhere(chip.key, where))}
          </div>
        );
      })}

      {addingKey !== null ? (
        <div className="flex flex-col gap-2 rounded-[2px] border border-border bg-background p-2.5">
          <ReadingEditor
            key={addingKey}
            // The stored chip once there is one, so a `where` set beside it rides the next keystroke;
            // before the first digit, the where waits here and rides the first one.
            reading={freshReading}
            onChange={(next) =>
              dispatch({ type: 'select', field: 'thickness', key: addingKey, value: next })
            }
            onRemove={() => {
              if (adding) dispatch({ type: 'deselect', field: 'thickness', key: addingKey });
              setPendingWhere(undefined);
              setAddingKey(null);
            }}
            fresh
          />
          {placeOf(addingKey, freshReading, (where) => {
            if (adding) setWhere(addingKey, where);
            else setPendingWhere(where);
          })}
        </div>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        // A second measurement: the one being typed settles into the list as its chip and a fresh
        // editor opens under the next key. With nothing typed yet, `nextKey()` is the key already
        // open, and the click is a no-op.
        onClick={() => {
          const key = nextKey();
          if (key === addingKey) return;
          setPendingWhere(undefined);
          setAddingKey(key);
        }}
      >
        + A measurement
      </Button>
    </SheetPanel>
  );
}

/**
 * A reading named by its figure, for the where question's banner — "Where is the 4.5″ measurement?"
 * — so two readings' questions are told apart. The method and the skater's word stay off it.
 */
export function readingLabel(reading: ThicknessReadingInput): string {
  const { supportable: _word, ...figure } = reading;
  const text = formatThicknessReading(figure);
  if (text === null) return 'New measurement';
  const method = ` (${THICKNESS_METHOD_LABELS[reading.method]})`;
  return `${text.endsWith(method) ? text.slice(0, -method.length) : text} measurement`;
}

/** The closed chip: what was picked, in words, or the way to pick it. */
function placeLabel(
  where: Where | undefined,
  bayNames: Readonly<Record<string, string>>,
  instrument: boolean,
): string {
  if (where === undefined) return instrument ? 'Choose on the lake' : 'Choose a place';
  const words = describeWhere(where, bayNames);
  if (words) return `${words[0]?.toUpperCase()}${words.slice(1)}`;
  return where.point ? 'A point on the lake' : 'Somewhere on the lake';
}

type Mode = 'single' | 'range' | 'poke';

function modeOf(r: ThicknessReadingInput): Mode {
  if (r.method === 'poke') return 'poke';
  if (r.valueCm !== undefined || (r.minCm === undefined && r.maxCm === undefined)) return 'single';
  return 'range';
}

const inches = (cm: number | undefined) =>
  cm === undefined ? '' : String(roundTo(cmToInches(cm), 1));

/**
 * One reading, as the skater enters it: inches (a number or a range, either end optional — a lower
 * bound is "at least"), the method, a poke count, the word. Emits a whole reading on every change
 * so the chip's value is always what is on screen; a fresh editor emits once it has anything.
 */
function ReadingEditor({
  reading,
  onChange,
  onRemove,
  fresh = false,
}: {
  reading: ThicknessReadingInput;
  onChange: (next: ThicknessReadingInput) => void;
  onRemove: () => void;
  fresh?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(modeOf(reading));
  const [method, setMethod] = useState<ThicknessMethod>(reading.method);
  const [value, setValue] = useState(inches(reading.valueCm));
  const [min, setMin] = useState(inches(reading.minCm));
  const [max, setMax] = useState(inches(reading.maxCm));
  const [pokes, setPokes] = useState(
    reading.pokeCount === undefined ? '' : String(reading.pokeCount),
  );
  const [supportable, setSupportable] = useState(reading.supportable);

  const num = (v: string) =>
    v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
  const build = (
    over: Partial<{
      mode: Mode;
      method: ThicknessMethod;
      value: string;
      min: string;
      max: string;
      pokes: string;
      supportable: boolean | undefined;
    }>,
  ) => {
    const m = over.mode ?? mode;
    const meth = over.method ?? (m === 'poke' ? 'poke' : method === 'poke' ? 'estimated' : method);
    const v = num(over.value ?? value);
    const lo = num(over.min ?? min);
    const hi = num(over.max ?? max);
    const count = num(over.pokes ?? pokes);
    const word = 'supportable' in over ? over.supportable : supportable;
    const single = m === 'single' || (m === 'poke' && v !== undefined);
    const next: ThicknessReadingInput = {
      method: meth,
      // A number in the single mode, and the poke mode's guess — the validator takes a `valueCm`
      // beside a count, never beside a range — else whatever range the reading carries.
      ...(single && v !== undefined ? { valueCm: inchesToCm(v) } : {}),
      ...(!single && lo !== undefined ? { minCm: inchesToCm(lo) } : {}),
      ...(!single && hi !== undefined ? { maxCm: inchesToCm(hi) } : {}),
      ...(meth === 'poke' && count !== undefined ? { pokeCount: Math.round(count) } : {}),
      ...(word !== undefined ? { supportable: word } : {}),
      ...(reading.where !== undefined ? { where: reading.where } : {}),
    };
    const hasFigure =
      next.valueCm !== undefined ||
      next.minCm !== undefined ||
      next.maxCm !== undefined ||
      next.pokeCount !== undefined;
    if (fresh && !hasFigure) return;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(['single', 'range', 'poke'] as const).map((m) => (
          <SheetChip
            key={m}
            compact
            label={m === 'single' ? 'A number' : m === 'range' ? 'A range' : 'Pokes'}
            {...(mode === m ? { tier: 'solid' as const } : {})}
            onClick={() => {
              setMode(m);
              if (m === 'poke') setMethod('poke');
              else if (method === 'poke') setMethod('estimated');
              build({ mode: m });
            }}
          />
        ))}
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      </div>
      {mode === 'single' ? (
        <Input
          inputMode="decimal"
          className="max-w-40"
          placeholder="inches"
          aria-label="Thickness in inches"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            build({ value: e.target.value });
          }}
        />
      ) : mode === 'range' ? (
        <div className="flex max-w-80 items-center gap-2">
          <Input
            inputMode="decimal"
            placeholder="at least"
            aria-label="At least, in inches"
            value={min}
            onChange={(e) => {
              setMin(e.target.value);
              build({ min: e.target.value });
            }}
          />
          <span className="text-foreground-muted">–</span>
          <Input
            inputMode="decimal"
            placeholder="at most"
            aria-label="At most, in inches"
            value={max}
            onChange={(e) => {
              setMax(e.target.value);
              build({ max: e.target.value });
            }}
          />
        </div>
      ) : (
        <div className="flex max-w-96 items-center gap-2">
          <Input
            inputMode="numeric"
            placeholder="pokes to go through"
            aria-label="Pokes to go through"
            value={pokes}
            onChange={(e) => {
              setPokes(e.target.value);
              build({ pokes: e.target.value });
            }}
          />
          <Input
            inputMode="decimal"
            placeholder="your guess, in"
            aria-label="Your guess, in inches"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              build({ value: e.target.value });
            }}
          />
        </div>
      )}
      {mode !== 'poke' ? (
        <div className="flex flex-wrap gap-1.5">
          {THICKNESS_METHODS.filter((m) => m !== 'poke').map((m) => (
            <SheetChip
              key={m}
              compact
              label={THICKNESS_METHOD_LABELS[m]}
              {...(method === m ? { tier: 'solid' as const } : {})}
              onClick={() => {
                setMethod(m);
                build({ method: m });
              }}
            />
          ))}
        </div>
      ) : null}
      <SubLabel>Did it hold you?</SubLabel>
      <div className="flex flex-wrap gap-1.5">
        <SheetChip
          compact
          label="Held me"
          {...(supportable === true ? { tier: 'solid' as const } : {})}
          onClick={() => {
            const next = supportable === true ? undefined : true;
            setSupportable(next);
            build({ supportable: next });
          }}
        />
        <SheetChip
          compact
          label="Didn't hold"
          {...(supportable === false ? { tier: 'solid' as const } : {})}
          onClick={() => {
            const next = supportable === false ? undefined : false;
            setSupportable(next);
            build({ supportable: next });
          }}
        />
      </div>
    </div>
  );
}
