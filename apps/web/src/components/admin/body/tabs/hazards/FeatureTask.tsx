import {
  BODY_FEATURE_TYPE_LABELS,
  BODY_FEATURE_TYPES,
  type BodyFeatureType,
  MAX_BODY_FEATURE_NOTE_LENGTH,
} from '@skating/core';

import { Button } from '@/components/kit/button';
import { Field, FieldLabel, Input } from '@/components/kit/input';
import { Kbd } from '@/components/kit/kbd';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/kit/select';
import { Textarea } from '@/components/kit/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { cn } from '@/lib/utils';
import {
  FEATURE_SIZE_MAX_M,
  FEATURE_SIZE_MIN_M,
  FEATURE_WAY_LABELS,
  FEATURE_WAYS,
  type FeatureDraft,
  type FeatureWay,
  featureTaskHeading,
  featureTaskNote,
  saveBlocker,
  sizeField,
} from './featureDraft';

/**
 * **The known-feature task** (B01-6b, D300): a feature being drawn, over the tab's own blocks, framed
 * in the mode's ice as the bay task is — no board draws it, so it follows the bay task's pattern and
 * waits on the founder's look pass. Its header says what it is for (a new feature, a redraw); a new
 * feature's type and note; the way it is drawn (the segments switch the map's engine); a point's
 * radius or a line's band; the paste box; what still stands in the save's way; *Save* (⌘S) and
 * *Discard* (Esc on the map).
 *
 * Props only: the tab holds the draft (`featureDraft`) and the map's claim.
 */

export interface FeatureTaskProps {
  draft: FeatureDraft;
  saving: boolean;
  onType: (type: BodyFeatureType) => void;
  onNote: (note: string) => void;
  onWay: (way: FeatureWay) => void;
  onRadius: (radius: string) => void;
  onBand: (band: string) => void;
  onPaste: (paste: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

export function FeatureTask({
  draft,
  saving,
  onType,
  onNote,
  onWay,
  onRadius,
  onBand,
  onPaste,
  onSave,
  onDiscard,
}: FeatureTaskProps) {
  const blocker = saveBlocker(draft);
  const note = featureTaskNote(draft);
  const size = sizeField(draft);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (blocker === null && !saving) onSave();
    }
  };
  return (
    <fieldset
      aria-label={featureTaskHeading(draft)}
      data-slot="feature-task"
      onKeyDown={onKeyDown}
      className={cn(
        'm-0 flex min-w-0 flex-col gap-(--space-3_5) border border-solid border-acc p-(--space-4)',
        'shadow-[0_0_0_3px_var(--acc-wash),0_0_18px_var(--acc-glow)]',
      )}
    >
      <div className="-mx-(--space-4) border-b border-solid border-line px-(--space-4) pb-(--space-3)">
        <span className="text-kick leading-none font-semibold tracking-kick text-acc uppercase">
          {featureTaskHeading(draft)}
        </span>
        {note !== null && (
          <p className="m-0 mt-(--space-2) text-assist leading-list text-fg3">{note}</p>
        )}
      </div>
      {draft.target.kind === 'new' && (
        <>
          <Field>
            <FieldLabel>What it is</FieldLabel>
            <Select
              value={draft.type}
              onValueChange={(v) => {
                if (v !== null) onType(v as BodyFeatureType);
              }}
            >
              <SelectTrigger aria-label="What it is" data-slot="feature-task-type">
                <SelectValue>{(v: BodyFeatureType) => BODY_FEATURE_TYPE_LABELS[v]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {BODY_FEATURE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {BODY_FEATURE_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Note</FieldLabel>
            <Input
              data-slot="feature-task-note"
              value={draft.note}
              maxLength={MAX_BODY_FEATURE_NOTE_LENGTH}
              placeholder="Optional, a few words"
              onChange={(e) => onNote(e.target.value)}
            />
          </Field>
        </>
      )}
      <Field>
        <FieldLabel>Draw</FieldLabel>
        <ToggleGroup
          variant="well"
          aria-label="How to draw it"
          value={draft.way}
          onValueChange={(v) => onWay(v as FeatureWay)}
        >
          {FEATURE_WAYS.map((w) => (
            <ToggleGroupItem key={w} value={w}>
              {FEATURE_WAY_LABELS[w]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      {size !== null && (
        <Field>
          <FieldLabel>
            {size === 'radius' ? 'Radius in meters' : 'Band each side, in meters'}
          </FieldLabel>
          <Input
            data-slot="feature-task-size"
            type="number"
            inputMode="numeric"
            min={FEATURE_SIZE_MIN_M}
            max={FEATURE_SIZE_MAX_M}
            step={1}
            value={size === 'radius' ? draft.radius : draft.band}
            onChange={(e) => (size === 'radius' ? onRadius : onBand)(e.target.value)}
            className="w-28"
          />
        </Field>
      )}
      {draft.way === 'paste' && (
        <Field>
          <FieldLabel>GeoJSON</FieldLabel>
          <Textarea
            data-slot="feature-task-paste"
            rows={5}
            value={draft.paste}
            placeholder="A Polygon, MultiPolygon or LineString, bare or in a Feature"
            onChange={(e) => onPaste(e.target.value)}
            className="font-(family-name:--family-mono) text-assist"
          />
        </Field>
      )}
      {draft.unavailable && (draft.way === 'polygon' || draft.way === 'line') && (
        <p data-slot="feature-task-unavailable" className="m-0 text-assist text-warn">
          The draw tool couldn’t load. Paste the shape as GeoJSON instead.
        </p>
      )}
      {blocker !== null && (
        <p
          data-slot="feature-task-blocker"
          className={cn(
            'm-0 text-assist',
            draft.refusal !== null || draft.geometry !== null ? 'text-warn' : 'text-fg3',
          )}
        >
          {blocker}
        </p>
      )}
      <div className="flex items-center gap-(--space-2)">
        <Button
          variant="primary"
          data-slot="feature-task-save"
          disabled={blocker !== null}
          loading={saving}
          onClick={onSave}
        >
          Save
          <Kbd variant="dim" aria-hidden="true">
            ⌘S
          </Kbd>
        </Button>
        <Button data-slot="feature-task-discard" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
      </div>
    </fieldset>
  );
}
