import { HIKE_IN_ASSERT_M, MAX_PLACE_NAME_CHARS, MAX_PUT_IN_NAME_LENGTH } from '@skating/core';

import { Button } from '@/components/kit/button';
import { CheckboxRow } from '@/components/kit/checkbox';
import { Field, FieldLabel, Input } from '@/components/kit/input';
import { Kbd } from '@/components/kit/kbd';
import { cn } from '@/lib/utils';
import {
  type AccessDraft,
  needsHikeIn,
  pickedLot,
  saveBlocker,
  straightMeters,
  taskHeading,
} from './accessDraft';
import type { LotRow } from './accessModel';

/**
 * **The Access tab's task block** (B01-6b): a put-in or a lot being placed on the console map, or a
 * lot being linked to a put-in, over the tab's own blocks and framed in the mode's ice as the bay
 * task is. A placement holds its optional name; a link says which lot is picked and how far it is in
 * a straight line, offers *No parking*, and the hike-in assertion D144 asks for past a mile. What
 * stands in the save's way is said under the fields; *Save* (⌘S) and *Discard* (Esc on the map).
 *
 * Props only: the tab holds the draft (`accessDraft`) and the map's claim. No board draws the put-in
 * task or the link's fields; they follow parking mode's pattern and wait on the look pass.
 */

export interface AccessTaskProps {
  draft: AccessDraft;
  /** The body's lots, for the link's picked lot. */
  lots: readonly LotRow[];
  saving: boolean;
  onName: (name: string) => void;
  onNoParking: () => void;
  onHikeIn: (hikeIn: boolean) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** The task's one line under the header. */
export function accessTaskNote(draft: AccessDraft): string {
  if (draft.kind === 'putIn') {
    return 'It snaps to the water’s edge, and shows in the app as an official put-in.';
  }
  if (draft.kind === 'lot') {
    return 'A lot can be any distance from the ice. Link it to a put-in once it’s saved.';
  }
  return 'The walk is measured along the trails once it saves. Until then it reads as at least the straight line.';
}

const meters = (m: number) => `${m.toLocaleString('en-US')} m`;

export function AccessTask({
  draft,
  lots,
  saving,
  onName,
  onNoParking,
  onHikeIn,
  onSave,
  onDiscard,
}: AccessTaskProps) {
  const blocker = saveBlocker(draft);
  const heading = taskHeading(draft);
  // ⌘S saves from anywhere in the task (the boards' key on the button).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (blocker === null && !saving) onSave();
    }
  };
  return (
    <fieldset
      aria-label={heading}
      data-slot="access-task"
      onKeyDown={onKeyDown}
      className={cn(
        'm-0 flex min-w-0 flex-col gap-(--space-3_5) border border-solid border-acc p-(--space-4)',
        'shadow-[0_0_0_3px_var(--acc-wash),0_0_18px_var(--acc-glow)]',
      )}
    >
      <div className="-mx-(--space-4) border-b border-solid border-line px-(--space-4) pb-(--space-3)">
        <span className="text-kick leading-none font-semibold tracking-kick text-acc uppercase">
          {heading}
        </span>
        <p className="m-0 mt-(--space-2) text-assist leading-list text-fg3">
          {accessTaskNote(draft)}
        </p>
      </div>
      {draft.kind === 'putIn' ? (
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            data-slot="access-task-name"
            value={draft.name}
            maxLength={MAX_PUT_IN_NAME_LENGTH}
            placeholder="Optional, what skaters call it"
            onChange={(e) => onName(e.target.value)}
          />
        </Field>
      ) : draft.kind === 'lot' ? (
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            data-slot="access-task-name"
            value={draft.name}
            maxLength={MAX_PLACE_NAME_CHARS}
            placeholder="Optional, as the sign says"
            onChange={(e) => onName(e.target.value)}
          />
        </Field>
      ) : (
        <LinkFields draft={draft} lots={lots} onNoParking={onNoParking} onHikeIn={onHikeIn} />
      )}
      {blocker !== null && (
        <p data-slot="access-task-blocker" className="m-0 text-assist text-fg3">
          {blocker}
        </p>
      )}
      <div className="flex items-center gap-(--space-2)">
        <Button
          variant="primary"
          data-slot="access-task-save"
          disabled={blocker !== null}
          loading={saving}
          onClick={onSave}
        >
          Save
          <Kbd variant="dim" aria-hidden="true">
            ⌘S
          </Kbd>
        </Button>
        <Button data-slot="access-task-discard" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
      </div>
    </fieldset>
  );
}

function LinkFields({
  draft,
  lots,
  onNoParking,
  onHikeIn,
}: {
  draft: Extract<AccessDraft, { kind: 'link' }>;
  lots: readonly LotRow[];
  onNoParking: () => void;
  onHikeIn: (hikeIn: boolean) => void;
}) {
  const lot = pickedLot(draft, lots);
  const straight = straightMeters(draft, lots);
  const long = needsHikeIn(draft, lots);
  return (
    <>
      <div className="flex flex-col gap-(--space-1)">
        <span className="text-kick tracking-kick text-fg3 uppercase">Lot</span>
        <span data-slot="access-task-lot" className="text-row text-fg">
          {draft.choice === 'none'
            ? 'No parking'
            : lot !== null
              ? (lot.name ?? 'Unnamed lot')
              : 'None picked yet'}
        </span>
        {straight !== null && (
          <span data-slot="access-task-straight" className="text-assist text-fg3">
            {meters(straight)} from the put-in in a straight line
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-(--space-2)">
        <Button
          size="sm"
          data-slot="access-task-no-parking"
          aria-pressed={draft.choice === 'none'}
          onClick={onNoParking}
        >
          No parking
        </Button>
      </div>
      {draft.choice !== 'none' && (
        <CheckboxRow
          data-slot="access-task-hike-in"
          checked={draft.hikeIn}
          onCheckedChange={(checked) => onHikeIn(checked)}
          label="It’s a hike-in"
          description="Skaters see a hike-in chip on the lake."
        />
      )}
      {long && !draft.hikeIn && (
        <p data-slot="access-task-long" className="m-0 text-assist text-warn">
          That’s over {meters(HIKE_IN_ASSERT_M)} in a straight line, so it has to be marked a
          hike-in before it can link.
        </p>
      )}
    </>
  );
}
