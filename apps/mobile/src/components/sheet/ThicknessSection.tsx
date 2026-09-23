import {
  cmToInches,
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
} from '@skating/core';
import { useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';
import { Input } from '../ThemedInputs';
import { SheetChip } from './SheetChip';
import { SheetHint, SheetSection, SubLabel } from './SheetSection';
import type { SectionProps } from './sectionProps';
import { WherePicker } from './WherePicker';

const SCOPE_LABELS: Record<ThicknessScope, string> = {
  everywhere_tested: 'Everywhere I tested',
  at_spot: 'At this spot',
};

/**
 * *Thickness* (A10 / D195). The quick path first — *under 2 / 2–3 / 3–4 / 4–6 / 6+* — with a scope;
 * the precise path underneath: a number or a range in inches, measured or estimated or a poke
 * count, a lower bound alone ("at least 4"), the skater's own *held me* / *didn't hold* word, and a
 * where per reading. The word is the skater's, never ours (D3).
 */
export function ThicknessSection({ report, body, dispatch, gaps, timeZone }: SectionProps) {
  const sheet = report.sheet;
  const chips = sheet.fields.thickness.chips;
  const band = chips.map((c) => thicknessBandOfKey(c.key)).find((b) => b !== null) ?? null;
  const precise = chips.filter((c) => thicknessBandOfKey(c.key) === null && c.tier !== 'ghost');
  // The reading being typed, by the key it will be stored under: minted when *+ A measurement* is
  // tapped, so the fresh editor stays the same editor from the first digit to the last rather than
  // closing on the first keystroke and reopening as the chip's own (which drops the keyboard).
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [whereFor, setWhereFor] = useState<string | null>(null);
  const scope = sheet.scalars.thicknessScope;
  const nextKey = () => {
    let n = 1;
    while (chips.some((c) => c.key === `reading:${n}`)) n++;
    return `reading:${n}`;
  };
  const adding = addingKey === null ? null : (precise.find((c) => c.key === addingKey) ?? null);

  return (
    <SheetSection
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
      <XStack gap={6} flexWrap="wrap">
        {THICKNESS_BANDS.map((b) => (
          <SheetChip
            key={b}
            label={THICKNESS_BAND_LABELS[b]}
            tier={band === b ? 'solid' : undefined}
            onPress={() => dispatch({ type: 'selectThicknessBand', band: band === b ? null : b })}
          />
        ))}
        <SheetChip
          label="Didn't check"
          tier={
            band === null && precise.length === 0 && sheet.fields.thickness.touched
              ? 'solid'
              : undefined
          }
          onPress={() => dispatch({ type: 'selectThicknessBand', band: null })}
        />
      </XStack>
      {band !== null || precise.length > 0 ? (
        <XStack gap={6} flexWrap="wrap" alignItems="center">
          {(Object.keys(SCOPE_LABELS) as ThicknessScope[]).map((s) => (
            <SheetChip
              key={s}
              compact
              label={SCOPE_LABELS[s]}
              tier={scope === s ? 'solid' : undefined}
              onPress={() =>
                dispatch({
                  type: 'setScalar',
                  key: 'thicknessScope',
                  value: scope === s ? undefined : s,
                })
              }
            />
          ))}
        </XStack>
      ) : null}

      {precise.map((chip) => {
        if (chip.key === addingKey) return null; // drawn below, as the editor that is typing it
        const r = chip.value;
        return (
          <YStack
            key={chip.key}
            gap="$2"
            padding="$3"
            borderRadius="$xs"
            backgroundColor="$surfaceMuted"
          >
            <ReadingEditor
              reading={r}
              onChange={(next) =>
                dispatch({ type: 'select', field: 'thickness', key: chip.key, value: next })
              }
              onRemove={() => dispatch({ type: 'deselect', field: 'thickness', key: chip.key })}
            />
            <XStack gap="$2">
              <SheetChip
                compact
                label={r.where ? 'Where: set' : 'Where?'}
                tier={r.where ? 'solid' : undefined}
                onPress={() => setWhereFor(whereFor === chip.key ? null : chip.key)}
              />
            </XStack>
            {whereFor === chip.key ? (
              <WherePicker
                where={r.where}
                body={body}
                onChange={(where) =>
                  dispatch({ type: 'setWhere', field: 'thickness', key: chip.key, where })
                }
              />
            ) : null}
          </YStack>
        );
      })}

      {addingKey !== null ? (
        <YStack gap="$2" padding="$3" borderRadius="$xs" backgroundColor="$surfaceMuted">
          <ReadingEditor
            key={addingKey}
            // The stored chip once there is one, so a `where` set beside it rides the next keystroke.
            reading={adding?.value ?? { method: 'measured' }}
            onChange={(next) =>
              dispatch({ type: 'select', field: 'thickness', key: addingKey, value: next })
            }
            onRemove={() => {
              if (adding) dispatch({ type: 'deselect', field: 'thickness', key: addingKey });
              setAddingKey(null);
            }}
            fresh
          />
          {adding ? (
            <XStack gap="$2">
              <SheetChip
                compact
                label={adding.value.where ? 'Where: set' : 'Where?'}
                tier={adding.value.where ? 'solid' : undefined}
                onPress={() => setWhereFor(whereFor === addingKey ? null : addingKey)}
              />
            </XStack>
          ) : null}
          {adding && whereFor === addingKey ? (
            <WherePicker
              where={adding.value.where}
              body={body}
              onChange={(where) =>
                dispatch({ type: 'setWhere', field: 'thickness', key: addingKey, where })
              }
            />
          ) : null}
        </YStack>
      ) : null}
      <Button
        size="$2"
        alignSelf="flex-start"
        chromeless
        // A second measurement: the one being typed settles into the list as its chip and a fresh
        // editor opens under the next key. With nothing typed yet, `nextKey()` is the key already
        // open, and the tap is a no-op.
        onPress={() => setAddingKey(nextKey())}
      >
        + A measurement
      </Button>
    </SheetSection>
  );
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
    <YStack gap="$2">
      <XStack gap={6} flexWrap="wrap" alignItems="center">
        {(['single', 'range', 'poke'] as const).map((m) => (
          <SheetChip
            key={m}
            compact
            label={m === 'single' ? 'A number' : m === 'range' ? 'A range' : 'Pokes'}
            tier={mode === m ? 'solid' : undefined}
            onPress={() => {
              setMode(m);
              if (m === 'poke') setMethod('poke');
              else if (method === 'poke') setMethod('estimated');
              build({ mode: m });
            }}
          />
        ))}
        <XStack flex={1} />
        <Button size="$2" chromeless onPress={onRemove}>
          Remove
        </Button>
      </XStack>
      {mode === 'single' ? (
        <Input
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="inches"
          value={value}
          onChangeText={(v) => {
            setValue(v);
            build({ value: v });
          }}
        />
      ) : mode === 'range' ? (
        <XStack gap="$2" alignItems="center">
          <Input
            flex={1}
            keyboardType="decimal-pad"
            inputMode="decimal"
            placeholder="at least"
            value={min}
            onChangeText={(v) => {
              setMin(v);
              build({ min: v });
            }}
          />
          <Text color="$foregroundMuted">–</Text>
          <Input
            flex={1}
            keyboardType="decimal-pad"
            inputMode="decimal"
            placeholder="at most"
            value={max}
            onChangeText={(v) => {
              setMax(v);
              build({ max: v });
            }}
          />
        </XStack>
      ) : (
        <XStack gap="$2" alignItems="center">
          <Input
            flex={1}
            keyboardType="number-pad"
            inputMode="numeric"
            placeholder="pokes to go through"
            value={pokes}
            onChangeText={(v) => {
              setPokes(v);
              build({ pokes: v });
            }}
          />
          <Input
            flex={1}
            keyboardType="decimal-pad"
            inputMode="decimal"
            placeholder="your guess, in"
            value={value}
            onChangeText={(v) => {
              setValue(v);
              build({ value: v });
            }}
          />
        </XStack>
      )}
      {mode !== 'poke' ? (
        <XStack gap={6} flexWrap="wrap">
          {THICKNESS_METHODS.filter((m) => m !== 'poke').map((m) => (
            <SheetChip
              key={m}
              compact
              label={THICKNESS_METHOD_LABELS[m]}
              tier={method === m ? 'solid' : undefined}
              onPress={() => {
                setMethod(m);
                build({ method: m });
              }}
            />
          ))}
        </XStack>
      ) : (
        <SheetHint>Pokes are yours and your pole's — the count is kept as a count.</SheetHint>
      )}
      <SubLabel>Did it hold you?</SubLabel>
      <XStack gap={6} flexWrap="wrap">
        <SheetChip
          compact
          label="Held me"
          tier={supportable === true ? 'solid' : undefined}
          onPress={() => {
            const next = supportable === true ? undefined : true;
            setSupportable(next);
            build({ supportable: next });
          }}
        />
        <SheetChip
          compact
          label="Didn't hold"
          tier={supportable === false ? 'solid' : undefined}
          onPress={() => {
            const next = supportable === false ? undefined : false;
            setSupportable(next);
            build({ supportable: next });
          }}
        />
      </XStack>
    </YStack>
  );
}
