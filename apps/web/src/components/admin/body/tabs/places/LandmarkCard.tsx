import { LANDMARK_KIND_LABELS, LANDMARK_KINDS, type LandmarkKind } from '@skating/core';
import { type ReactNode, useRef, useState } from 'react';

import { Tag, TagRun } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { ChipInput } from '@/components/kit/chip-input';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Input, InputGroup, InputGroupKbd } from '@/components/kit/input';
import { Kbd } from '@/components/kit/kbd';
import { Section } from '@/components/kit/section-slug';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/kit/select';
import { usePaneKeys } from '@/lib/keys';

import { sayUnavailable, UnavailableButton } from '../access/kit-candidates/unavailable-button';
import { BLOCK_GAP, dayMonthYear } from '../names/tabParts';
import { InsetCard, InsetCardFoot } from './kit-candidates/inset-card';
import { acres, CATALOG_NAMES, formatPoint, type LandmarkRow, PROMOTABLE } from './placesModel';

/**
 * Board 5.4.3 | Landmark: the selected landmark on the inset card over the list. Its fields save as
 * they change — the server's `update` writes one edit at a time and records what it replaced, so
 * each undoes from its toast and from History — so the card has no Save; its foot holds what can be
 * done to the landmark itself (moving it, drawing it as a bay, removing it), each a map tool not
 * built yet, which says so.
 */

/** One edit to a landmark: its name, its other spellings, or its kind. */
export type LandmarkEdit = { name: string } | { aliases: string[] } | { kind: LandmarkKind };

const TOOLS = {
  move: 'Moving a landmark on the map comes with the map’s landmark tools.',
  bay: 'Drawing a landmark as a bay comes with the bay tools.',
  remove: 'Removing a landmark, with its reason, comes with the landmark tools.',
};

/** A field's kicker over its control, 7 px apart (the card's `.in`). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--space-1_5)">
      <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

export function LandmarkCard({
  landmark: l,
  canPlace,
  onBack,
  onEdit,
}: {
  landmark: LandmarkRow;
  canPlace: boolean;
  onBack: () => void;
  onEdit?: ((edit: LandmarkEdit) => void) | undefined;
}) {
  const card = useRef<HTMLElement>(null);
  const [name, setName] = useState(l.name);
  const promotable = PROMOTABLE.has(l.kind);
  usePaneKeys(card, [
    { key: 'M', run: () => sayUnavailable(TOOLS.move), enabled: canPlace },
    { key: 'B', run: () => sayUnavailable(TOOLS.bay), enabled: canPlace && promotable },
  ]);
  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed !== '' && trimmed !== l.name) onEdit?.({ name: trimmed });
    else setName(l.name);
  };
  return (
    <InsetCard
      ref={card}
      back="Back to landmarks"
      onBack={onBack}
      // Over the whole inspector under the tab grid, 12 px in from the pane and its foot.
      className="absolute -inset-x-(--space-2) -top-(--space-3) bottom-(--space-3)"
      foot={
        canPlace ? (
          <InsetCardFoot end={<UnavailableButton what={TOOLS.remove}>Remove</UnavailableButton>}>
            <UnavailableButton what={TOOLS.move}>
              Move
              <Kbd variant="dim" aria-hidden="true">
                M
              </Kbd>
            </UnavailableButton>
            {promotable ? (
              <UnavailableButton what={TOOLS.bay}>
                Draw as a bay
                <Kbd variant="dim" aria-hidden="true">
                  B
                </Kbd>
              </UnavailableButton>
            ) : (
              // A verb this kind can't take keeps its place, inert (the disabled layer's dashes).
              <Button disabled className="border border-dashed border-line inset-ring-0">
                Draw as a bay
              </Button>
            )}
          </InsetCardFoot>
        ) : undefined
      }
    >
      <div className={`flex flex-col ${BLOCK_GAP} pb-(--space-5)`}>
        <Section
          title="Landmark"
          end={
            <TagRun>
              {l.catalogs.map((c) => (
                <Tag key={c}>{c}</Tag>
              ))}
            </TagRun>
          }
        >
          <div className="flex flex-col gap-(--space-3_5)">
            <Field label="Name">
              {onEdit ? (
                <InputGroup>
                  <Input
                    aria-label="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={saveName}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveName();
                    }}
                  />
                  <InputGroupKbd>⏎</InputGroupKbd>
                </InputGroup>
              ) : (
                <span className="text-body leading-list text-fg">{l.name}</span>
              )}
            </Field>
            <Field label="Other spellings">
              {onEdit ? (
                <ChipInput
                  aria-label="Other spellings"
                  value={l.aliases}
                  placeholder="Add a spelling skaters use"
                  onValueChange={(aliases) => onEdit({ aliases })}
                />
              ) : (
                <span className="text-body leading-list text-fg1">
                  {l.aliases.length > 0 ? l.aliases.join(', ') : 'None'}
                </span>
              )}
            </Field>
            <Field label="Kind">
              {onEdit ? (
                <Select
                  value={l.kind}
                  onValueChange={(v) => {
                    if (v !== null && v !== l.kind) onEdit({ kind: v as LandmarkKind });
                  }}
                >
                  <SelectTrigger aria-label="Kind">
                    <SelectValue>{(v: LandmarkKind) => LANDMARK_KIND_LABELS[v]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {LANDMARK_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {LANDMARK_KIND_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-body leading-list text-fg">
                  {LANDMARK_KIND_LABELS[l.kind]}
                </span>
              )}
            </Field>
          </div>
        </Section>
        <Section title="On the lake">
          <KeyValueList keyWidth="5.75rem">
            {l.bay !== null && <KeyValueRow label="Bay">{l.bay}</KeyValueRow>}
            <KeyValueRow label="Point" mono>
              {formatPoint(l.point)}
            </KeyValueRow>
            {l.areaSqM !== null && (
              <KeyValueRow label="Footprint">{acres(l.areaSqM)} ac</KeyValueRow>
            )}
          </KeyValueList>
        </Section>
        <Section title="Where it came from">
          <KeyValueList keyWidth="5.75rem">
            <KeyValueRow label="Source">
              <span className="flex flex-col gap-(--space-1_5)">
                {l.catalogs.map((c) => (
                  <span key={c}>
                    {CATALOG_NAMES[c] ?? c}
                    <Tag className="ms-(--space-2)">{c}</Tag>
                  </span>
                ))}
              </span>
            </KeyValueRow>
            {l.ids.length > 0 && (
              <KeyValueRow label="IDs">
                <span className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-baseline gap-y-(--space-1)">
                  {l.ids.map((id) => (
                    <span key={`${id.catalog}:${id.id}`} className="contents">
                      <Tag>{id.catalog}</Tag>
                      <span className="truncate font-(family-name:--family-mono) text-mono-sm leading-list font-medium text-fg1">
                        {id.id}
                      </span>
                    </span>
                  ))}
                </span>
              </KeyValueRow>
            )}
            {l.added !== null && (
              <KeyValueRow label="Added">
                <span className="flex flex-col gap-(--space-1)">
                  <span>{dayMonthYear(l.added.at)}</span>
                  <span className="text-fg3">{l.added.by}</span>
                </span>
              </KeyValueRow>
            )}
          </KeyValueList>
        </Section>
      </div>
    </InsetCard>
  );
}
