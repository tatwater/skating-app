import {
  LANDMARK_KIND_LABELS,
  LANDMARK_KINDS,
  type LandmarkKind,
  MAX_LANDMARK_NAME_LENGTH,
} from '@skating/core';

import { Button } from '@/components/kit/button';
import { ChipInput } from '@/components/kit/chip-input';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Input } from '@/components/kit/input';
import { InsetCard, InsetCardFoot } from '@/components/kit/inset-card';
import { Kbd } from '@/components/kit/kbd';
import { Section } from '@/components/kit/section-slug';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/kit/select';
import { cn } from '@/lib/utils';
import { BLOCK_GAP } from '../tabParts';
import { dropHeading, dropNote, type LandmarkDraft, landmarkSaveBlocker } from './landmarkDraft';
import { formatPoint } from './placesModel';

/**
 * **Drop a landmark** (board 5.4.3 | Places | Drop a Landmark, B01-6b): the landmark being placed, on
 * the inset card over the list — its name, other spellings and kind, where it is on the lake, and
 * *Add to the map*. The map holds the point tool meanwhile: a click places the point, and another
 * click or a drag moves it. An emailed name or a skater's proposal arrives here filled, its note
 * saying what the save answers. ⏎ in the name, or ⌘S anywhere in the card, adds it; the card's head
 * (or Esc, from outside a field — in one it only leaves the field) leaves without saving.
 *
 * Props only: the tab holds the draft (`landmarkDraft`) and the map's claim.
 */

export interface LandmarkDropProps {
  draft: LandmarkDraft;
  saving: boolean;
  onName: (name: string) => void;
  onAliases: (aliases: string[]) => void;
  onKind: (kind: LandmarkKind) => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** What an Esc belongs to before the card does. */
const FIELD = 'input, textarea, [contenteditable="true"]';

const KIND_ITEMS = Object.fromEntries(LANDMARK_KINDS.map((k) => [k, LANDMARK_KIND_LABELS[k]]));

/** A field's kicker over its control, 7 px apart (the card's `.in`), as the landmark's card has. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-(--space-1_5)">
      <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

export function LandmarkDrop({
  draft,
  saving,
  onName,
  onAliases,
  onKind,
  onSave,
  onDiscard,
}: LandmarkDropProps) {
  const blocker = landmarkSaveBlocker(draft);
  const note = dropNote(draft);
  const trySave = () => {
    if (blocker === null && !saving) onSave();
  };
  return (
    <InsetCard
      data-slot="landmark-drop"
      back="Back to landmarks"
      onBack={onDiscard}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          trySave();
        }
        // Esc in a field is the field's: it leaves the field, and never throws away the drop and
        // what was typed (the card's own Esc, and the map tool's, go back only from outside one).
        if (e.key === 'Escape' && e.target instanceof HTMLElement && e.target.closest(FIELD)) {
          e.preventDefault();
          e.target.blur();
        }
      }}
      className="absolute -inset-x-(--space-2) -top-(--space-3) bottom-(--space-3)"
      foot={
        <InsetCardFoot>
          <Button
            variant="primary"
            data-slot="landmark-drop-save"
            disabled={blocker !== null}
            loading={saving}
            onClick={trySave}
          >
            Add to the map
            <Kbd variant="dim" aria-hidden="true">
              ⏎
            </Kbd>
          </Button>
        </InsetCardFoot>
      }
    >
      <div className={cn('flex flex-col pb-(--space-5)', BLOCK_GAP)}>
        <Section title={dropHeading(draft)}>
          <div className="flex flex-col gap-(--space-3_5)">
            {note !== null && (
              <p data-slot="landmark-drop-note" className="m-0 text-assist leading-list text-fg3">
                {note}
              </p>
            )}
            <Field label="Name">
              <Input
                aria-label="Name"
                data-slot="landmark-drop-name"
                value={draft.name}
                maxLength={MAX_LANDMARK_NAME_LENGTH}
                placeholder="What skaters call it"
                onChange={(e) => onName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    trySave();
                  }
                }}
              />
            </Field>
            <Field label="Other spellings">
              <ChipInput
                aria-label="Other spellings"
                value={draft.aliases}
                placeholder="Add a spelling skaters use"
                maxLength={MAX_LANDMARK_NAME_LENGTH}
                onValueChange={onAliases}
              />
            </Field>
            <Field label="Kind">
              <Select
                items={KIND_ITEMS}
                value={draft.kind}
                onValueChange={(v) => {
                  if (v !== null) onKind(v as LandmarkKind);
                }}
              >
                <SelectTrigger aria-label="Kind">
                  <SelectValue placeholder="Choose a kind" />
                </SelectTrigger>
                <SelectContent>
                  {LANDMARK_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {LANDMARK_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </Section>
        <Section title="On the lake">
          <div className="flex flex-col gap-(--space-2_5)">
            <KeyValueList keyWidth="5.75rem">
              <KeyValueRow label="Point" mono>
                <span data-slot="landmark-drop-point">
                  {draft.point === null ? 'Not placed yet' : formatPoint(draft.point)}
                </span>
              </KeyValueRow>
            </KeyValueList>
            <p className="m-0 text-assist leading-list text-fg3">
              {draft.point === null
                ? 'Click the map where it is. '
                : 'Click the map again to move it. '}
              A label sits where skaters look for it: an island’s middle, a point’s tip, a river’s
              mouth.
            </p>
          </div>
        </Section>
        {blocker !== null && (
          <p data-slot="landmark-drop-blocker" className="m-0 text-assist text-fg3">
            {blocker}
          </p>
        )}
      </div>
    </InsetCard>
  );
}
