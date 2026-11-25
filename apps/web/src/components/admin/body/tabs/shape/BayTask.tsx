import { MAX_PLACE_NAME_CHARS } from '@skating/core';
import { useRef } from 'react';

import { Button } from '@/components/kit/button';
import { Field, FieldLabel, Input } from '@/components/kit/input';
import { Kbd } from '@/components/kit/kbd';
import { Textarea } from '@/components/kit/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { cn } from '@/lib/utils';
import { type BayDraft, saveBlocker, waysFor } from './bayDraft';
import type { BayWay } from './ShapeTab';

/**
 * **The bay task** (`body-v5.html`'s task block, B01-6a): the bay being drawn, over the tab's own
 * blocks, framed in the mode's ice — everything inside belongs to the task. Its header says what it
 * is for (a new bay, an Inbox ask, a landmark drawn as a bay, a redraw, a mouth); the fields (a new
 * bay's name and other spellings), the way it is drawn (the segments switch the map's engine), the
 * paste box, what still stands in the save's way, and *Save* (⌘S) and *Discard* (Esc on the map).
 *
 * Props only: the route holds the draft (`bayDraft`) and the map's claim.
 */

const WAY_LABELS: Record<BayWay, string> = { chord: 'Chord', freehand: 'Freehand', paste: 'Paste' };

export interface BayTaskProps {
  draft: BayDraft;
  saving: boolean;
  onName: (name: string) => void;
  onAliases: (aliases: string) => void;
  onWay: (way: BayWay) => void;
  onPaste: (paste: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** The task's header: what this drawing is for. */
export function bayTaskHeading(draft: BayDraft): string {
  const t = draft.target;
  if (t.kind === 'redraw') return `Redraw · ${t.name}`;
  if (t.kind === 'mouth')
    return t.mouth === null ? `Draw the mouth · ${t.name}` : `Move the mouth · ${t.name}`;
  if (t.request !== undefined) return 'Bay request · from the Inbox';
  if (t.promote !== undefined) return 'A landmark drawn as a bay';
  return 'New bay';
}

/** The task's one line under the header, when it has something to say. */
export function bayTaskNote(draft: BayDraft): string | null {
  const t = draft.target;
  if (t.kind === 'new' && t.request !== undefined) {
    return t.request.asks === 1
      ? 'Saving answers the ask.'
      : `Saving answers all ${t.request.asks} asks for this bay.`;
  }
  if (t.kind === 'new' && t.promote !== undefined) {
    return `The landmark ${t.promote.name} is removed when the bay saves, so the place isn’t on the map twice.`;
  }
  if (t.kind === 'redraw')
    return 'The new outline replaces the old one. Reports and hazards inside are placed again.';
  if (t.kind === 'mouth') return 'The bay is cut again from the shore at the new mouth.';
  return null;
}

export function BayTask({
  draft,
  saving,
  onName,
  onAliases,
  onWay,
  onPaste,
  onSave,
  onDiscard,
}: BayTaskProps) {
  const root = useRef<HTMLFieldSetElement | null>(null);
  const blocker = saveBlocker(draft);
  const ways = waysFor(draft.target);
  const note = bayTaskNote(draft);
  // ⌘S saves from anywhere in the task (the boards' key on the button).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (blocker === null && !saving) onSave();
    }
  };
  return (
    <fieldset
      ref={root}
      aria-label={bayTaskHeading(draft)}
      data-slot="bay-task"
      onKeyDown={onKeyDown}
      className={cn(
        'm-0 flex min-w-0 flex-col gap-(--space-3_5) border border-solid border-acc p-(--space-4)',
        'shadow-[0_0_0_3px_var(--acc-wash),0_0_18px_var(--acc-glow)]',
      )}
    >
      <div className="-mx-(--space-4) border-b border-solid border-line px-(--space-4) pb-(--space-3)">
        <span className="text-kick leading-none font-semibold tracking-kick text-acc uppercase">
          {bayTaskHeading(draft)}
        </span>
        {note !== null && (
          <p className="m-0 mt-(--space-2) text-assist leading-list text-fg3">{note}</p>
        )}
      </div>
      {draft.target.kind === 'new' && (
        <>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              data-slot="bay-task-name"
              value={draft.name}
              maxLength={MAX_PLACE_NAME_CHARS}
              placeholder="What skaters call it"
              onChange={(e) => onName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Aliases</FieldLabel>
            <Input
              data-slot="bay-task-aliases"
              value={draft.aliases}
              placeholder="Comma-separated"
              onChange={(e) => onAliases(e.target.value)}
            />
          </Field>
        </>
      )}
      {ways.length > 1 && (
        <Field>
          <FieldLabel>Draw</FieldLabel>
          <ToggleGroup
            variant="well"
            aria-label="How to draw it"
            value={draft.way}
            onValueChange={(v) => onWay(v as BayWay)}
          >
            {ways.map((w) => (
              <ToggleGroupItem key={w} value={w}>
                {WAY_LABELS[w]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      )}
      {draft.way === 'paste' && (
        <Field>
          <FieldLabel>GeoJSON</FieldLabel>
          <Textarea
            data-slot="bay-task-paste"
            rows={5}
            value={draft.paste}
            placeholder="A Polygon or MultiPolygon, bare or in a Feature"
            onChange={(e) => onPaste(e.target.value)}
            className="font-(family-name:--family-mono) text-assist"
          />
        </Field>
      )}
      {draft.ringUnavailable && draft.way === 'freehand' && (
        <p data-slot="bay-task-unavailable" className="m-0 text-assist text-warn">
          The draw tool couldn’t load. Paste the outline as GeoJSON instead.
        </p>
      )}
      {blocker !== null && (
        <p
          data-slot="bay-task-blocker"
          className={cn('m-0 text-assist', draft.refusal !== null ? 'text-warn' : 'text-fg3')}
        >
          {blocker}
        </p>
      )}
      <div className="flex items-center gap-(--space-2)">
        <Button
          variant="primary"
          data-slot="bay-task-save"
          disabled={blocker !== null}
          loading={saving}
          onClick={onSave}
        >
          Save
          <Kbd variant="dim" aria-hidden="true">
            ⌘S
          </Kbd>
        </Button>
        <Button data-slot="bay-task-discard" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
      </div>
    </fieldset>
  );
}
