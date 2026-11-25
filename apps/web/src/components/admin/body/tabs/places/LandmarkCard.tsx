import {
  AUDIT_REASON_MAX,
  LANDMARK_KIND_LABELS,
  LANDMARK_KINDS,
  type LandmarkKind,
  landmarkNameKey,
  MAX_LANDMARK_NAME_LENGTH,
} from '@skating/core';
import { type ReactNode, useRef, useState } from 'react';
import { isFailed, type Loadable } from '@/components/admin/reads/consoleReads';
import { Tag, TagRun } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { ChipInput } from '@/components/kit/chip-input';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Input, InputGroup, InputGroupKbd } from '@/components/kit/input';
import { InsetCard, InsetCardFoot } from '@/components/kit/inset-card';
import { Kbd } from '@/components/kit/kbd';
import { PersonLockup } from '@/components/kit/person-lockup';
import { Section } from '@/components/kit/section-slug';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/kit/select';
import { sayUnavailable, UnavailableButton } from '@/components/kit/unavailable-button';
import { SPELLINGS_KEPT_MOVING } from '../../consoleWords';
import { statusDate } from '../../frame/bodyModel';
import { listChanged, sayNotSaved, useBodyHold } from '../../frame/currentBody';
import { useTabKeys } from '../../frame/tabKeys';
import { ReasonAsk } from '../access/ReasonAsk';
import { chipChange, sameList, useListWriter } from '../listWriter';
import { BLOCK_GAP, useDraft } from '../tabParts';
import { CouldntRead, LoadingLine, NotRecorded } from '../tabStates';
import {
  type Added,
  acres,
  CATALOG_NAMES,
  formatPoint,
  type LandmarkRow,
  PROMOTABLE,
} from './placesModel';

/**
 * Board 5.4.3 | Landmark: the selected landmark on the inset card over the list. Its fields save as
 * they change — the server's `update` writes one edit at a time and records what it replaced, so
 * each undoes from its toast and from History — so the card has no Save; its foot holds what can be
 * done to the landmark itself: moving it on the map (B01-6b: the point tool, each move saved with
 * Undo, until Move again or Esc), drawing it as a bay (the Shape tab's bay task, B01-6a), and
 * removing it, with a reason kept in History (it takes a label away from skaters).
 */

/** One edit to a landmark: its name, its other spellings, or its kind. */
export type LandmarkEdit =
  | { name: string }
  /** The whole list, and the list it was built on (the server's compare-and-set). */
  | { aliases: string[]; expectedAliases?: string[] }
  | { kind: LandmarkKind };

const TOOLS = {
  bay: 'Drawing a landmark as a bay comes with the bay tools.',
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
  onDrawAsBay,
  moving = false,
  onMove,
  onRemove,
}: {
  landmark: LandmarkRow;
  canPlace: boolean;
  onBack: () => void;
  /** The map's point tool holds this landmark: a click or a drag moves it. */
  moving?: boolean;
  /** Start moving it on the map, or stop. */
  onMove?: (() => void) | undefined;
  /** Take it off the map, with the reason; resolves whether it landed (a refusal is a toast). */
  onRemove?: ((reason: string) => Promise<boolean>) | undefined;
  /**
   * Draw this landmark as a bay (B01-6a): the Shape tab's bay task, its name filled in; the landmark
   * goes away when the bay saves (D299). Absent: *Not available yet* (a viewer who can't draw bays).
   */
  onDrawAsBay?: (() => void) | undefined;
  /** Save one edit; a promise, when given, settles once the server has answered. */
  onEdit?: ((edit: LandmarkEdit) => unknown) | undefined;
}) {
  const card = useRef<HTMLElement>(null);
  // The record's name again once it moves (the save landing, an Undo), so a stale draft is never
  // shown or sent back.
  const [name, setName] = useDraft(l.name);
  // The name on its way to the server: ⏎ then a blur sends it once, not twice. Let go when the
  // answer lands (a refusal can be sent again) or the record's name moves.
  const sent = useRef<string | null>(null);
  const [sentFor, setSentFor] = useState(l.name);
  if (sentFor !== l.name) {
    setSentFor(l.name);
    sent.current = null;
  }
  // The other spellings are a whole list: a second chip added while the first is saving is
  // applied to the list the server acknowledged, never the one this render holds (`listWriter`).
  const hold = useBodyHold();
  const pushAliases = useListWriter<string>(
    `aliases:${l.id}`,
    l.aliases,
    async (next, base) => {
      try {
        const landing = onEdit?.({ aliases: [...next], expectedAliases: [...base] });
        return landing instanceof Promise ? (await landing) !== false : true;
      } catch (err) {
        // Moved underneath: the queue re-applies the change on the list as it now stands.
        const current = listChanged(err);
        if (current !== null) return { current: current as string[] };
        // Any other throw (the tab's `act` says its own refusals) is a refusal, never unhandled.
        return false;
      }
    },
    sameList,
    // Spelling changes always re-apply; a list that keeps moving is said, never dropped quietly.
    () => sayNotSaved(hold, SPELLINGS_KEPT_MOVING),
  );
  // A landmark's spellings fold as the server keeps them (`normalizeLandmarkNames`): "The Gut" and
  // "Gut" are one.
  const editAliases = (aliases: readonly string[]) =>
    void pushAliases(chipChange(l.aliases, aliases, landmarkNameKey));
  const promotable = PROMOTABLE.has(l.kind);
  useTabKeys(card, [
    { key: 'M', run: () => onMove?.(), enabled: canPlace && onMove !== undefined },
    {
      key: 'B',
      run: () => (onDrawAsBay ? onDrawAsBay() : sayUnavailable(TOOLS.bay)),
      enabled: canPlace && promotable,
    },
  ]);
  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed === sent.current) return;
    if (trimmed !== '' && trimmed !== l.name) {
      sent.current = trimmed;
      const landing = onEdit?.({ name: trimmed });
      if (landing instanceof Promise) {
        const clear = () => {
          if (sent.current === trimmed) sent.current = null;
        };
        void landing.then(clear, clear);
      }
    } else setName(l.name);
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
          <InsetCardFoot
            end={
              onRemove ? (
                <ReasonAsk
                  trigger={
                    <Button variant="danger" data-slot="landmark-remove">
                      Remove
                    </Button>
                  }
                  title={`Remove “${l.name}”`}
                  description="It comes off the map and out of the report sheet. The next import won’t bring it back; Undo or History will."
                  confirm="Remove"
                  label="Reason · kept in History"
                  placeholder="Why it comes off the map"
                  maxLength={AUDIT_REASON_MAX}
                  onConfirm={onRemove}
                />
              ) : undefined
            }
          >
            {onMove && (
              <Button data-slot="landmark-move" aria-pressed={moving} onClick={onMove}>
                {moving ? 'Done moving' : 'Move'}
                <Kbd variant="dim" aria-hidden="true">
                  M
                </Kbd>
              </Button>
            )}
            {promotable && onDrawAsBay ? (
              <Button data-slot="landmark-draw-as-bay" onClick={onDrawAsBay}>
                Draw as a bay
                <Kbd variant="dim" aria-hidden="true">
                  B
                </Kbd>
              </Button>
            ) : promotable ? (
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
                    maxLength={MAX_LANDMARK_NAME_LENGTH}
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
                  maxLength={MAX_LANDMARK_NAME_LENGTH}
                  onValueChange={editAliases}
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
            {l.bay !== null && (
              <KeyValueRow label="Bay">
                {l.bay === undefined ? (
                  <LoadingLine width="7rem" />
                ) : isFailed(l.bay) ? (
                  <CouldntRead />
                ) : (
                  l.bay
                )}
              </KeyValueRow>
            )}
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
                    {/* A catalog with no written name is its tag alone: never the key twice. */}
                    {CATALOG_NAMES[c]}
                    <Tag className={CATALOG_NAMES[c] !== undefined ? 'ms-(--space-2)' : undefined}>
                      {c}
                    </Tag>
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
            <KeyValueRow label="Added">
              <AddedValue added={l.added} />
            </KeyValueRow>
            <KeyValueRow label="Changed">
              <ChangedValue added={l.added} />
            </KeyValueRow>
          </KeyValueList>
        </Section>
      </div>
    </InsetCard>
  );
}

/**
 * When a moderator last edited a landmark and a lake merge last changed it, in the read's state —
 * or that neither is recorded. A merge is said as one, never as "Moved": the card's Move is a moved
 * point, which the read records as an edit.
 */
function ChangedValue({ added }: { added: Loadable<Added | null> }) {
  if (added === undefined) return <LoadingLine width="7rem" />;
  if (isFailed(added)) return <CouldntRead />;
  const parts = [
    added?.edited != null ? `Edited ${statusDate(added.edited)}` : null,
    added?.merged != null ? `By a merge ${statusDate(added.merged)}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return <NotRecorded />;
  return <span>{parts.join(' · ')}</span>;
}

/** When and by whom a landmark was added, in the read's state. */
function AddedValue({ added }: { added: Loadable<Added | null> }) {
  if (added === undefined) return <LoadingLine width="7rem" />;
  if (isFailed(added)) return <CouldntRead />;
  if (added === null) return <NotRecorded />;
  return (
    <span className="flex flex-col items-start gap-(--space-1)">
      <span>{statusDate(added.at)}</span>
      {typeof added.by === 'string' ? (
        <span className="text-fg3">{added.by}</span>
      ) : (
        <PersonLockup
          name={added.by.name}
          handle={added.by.handle}
          {...(added.by.href !== undefined ? { href: added.by.href } : {})}
        />
      )}
    </span>
  );
}
