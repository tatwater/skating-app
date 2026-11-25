import { Button } from '@/components/kit/button';
import { Field, FieldLabel, Input } from '@/components/kit/input';
import { Kbd } from '@/components/kit/kbd';
import { cn } from '@/lib/utils';
import {
  SAMPLE_SPACING_MAX_KM,
  SAMPLE_SPACING_MIN_KM,
  type SampleDraft,
  sampleSummary,
  spacingBlocker,
} from './sampleDraft';

/**
 * **The sample-point task** (B01-6b, D300): a suggested grid of weather sample points, shown on the
 * map while this block is up — the old editor's tool in the console's task frame, as the bay task
 * is drawn. The spacing, *Suggest again*, what the grid is, and *Save* (⌘S) or *Discard* (Esc on
 * the map). No board draws it; it waits on the founder's look pass.
 *
 * Props only: the tab holds the draft (`sampleDraft`) and the map's claim.
 */

export interface SampleTaskProps {
  draft: SampleDraft;
  saving: boolean;
  onSpacing: (spacing: string) => void;
  onSuggest: () => void;
  onSave: () => void;
  onDiscard: () => void;
}

export function SampleTask({
  draft,
  saving,
  onSpacing,
  onSuggest,
  onSave,
  onDiscard,
}: SampleTaskProps) {
  const blocker = spacingBlocker(draft);
  const n = draft.points.length;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!saving && n > 0) onSave();
    }
  };
  return (
    <fieldset
      aria-label="Suggested sample points"
      data-slot="sample-task"
      onKeyDown={onKeyDown}
      className={cn(
        'm-0 flex min-w-0 flex-col gap-(--space-3_5) border border-solid border-acc p-(--space-4)',
        'shadow-[0_0_0_3px_var(--acc-wash),0_0_18px_var(--acc-glow)]',
      )}
    >
      <div className="-mx-(--space-4) border-b border-solid border-line px-(--space-4) pb-(--space-3)">
        <span className="text-kick leading-none font-semibold tracking-kick text-acc uppercase">
          Suggested sample points
        </span>
        <p className="m-0 mt-(--space-2) text-assist leading-list text-fg3">
          Saving replaces where the weather is read for this body.
        </p>
      </div>
      <div className="flex items-end gap-(--space-2)">
        <Field>
          <FieldLabel>Spacing in km</FieldLabel>
          <Input
            data-slot="sample-task-spacing"
            type="number"
            inputMode="numeric"
            min={SAMPLE_SPACING_MIN_KM}
            max={SAMPLE_SPACING_MAX_KM}
            step={1}
            value={draft.spacing}
            onChange={(e) => onSpacing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && blocker === null) onSuggest();
            }}
            className="w-24"
          />
        </Field>
        <Button
          size="sm"
          data-slot="sample-task-suggest"
          disabled={blocker !== null || saving}
          onClick={onSuggest}
        >
          Suggest again
        </Button>
      </div>
      <p data-slot="sample-task-summary" className="m-0 text-assist leading-list text-fg2">
        {sampleSummary(draft)}
      </p>
      {blocker !== null && (
        <p data-slot="sample-task-blocker" className="m-0 text-assist text-warn">
          {blocker}
        </p>
      )}
      <div className="flex items-center gap-(--space-2)">
        <Button
          variant="primary"
          data-slot="sample-task-save"
          disabled={n === 0}
          loading={saving}
          onClick={onSave}
        >
          Save {n}
          <Kbd variant="dim" aria-hidden="true">
            ⌘S
          </Kbd>
        </Button>
        <Button data-slot="sample-task-discard" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
      </div>
    </fieldset>
  );
}
