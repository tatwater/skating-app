import {
  CORPUS_NAME_DISMISS_LABELS,
  CORPUS_NAME_DISMISS_REASONS,
  type CorpusNameDismissReason,
  type LandmarkKind,
  MAX_REQUEST_NOTE_LENGTH,
} from '@skating/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { isFailed } from '@/components/admin/reads/consoleReads';
import { Tag, TagRun } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { Kbd } from '@/components/kit/kbd';
import { PlaceMark } from '@/components/kit/map-marks';
import { PersonLockup } from '@/components/kit/person-lockup';
import { RadioGroup, RadioRow } from '@/components/kit/radio';
import { Section } from '@/components/kit/section-slug';
import { cn } from '@/lib/utils';
import { statusDate } from '../../frame/bodyModel';
import { useTabKeys } from '../../frame/tabKeys';
import { ReasonAsk } from '../access/ReasonAsk';
import { LIT_ROW, LoadingSection, litAttr, TabBody } from '../tabParts';
import { CouldntRead, LoadingLine, NOT_RECORDED, ReadFailures } from '../tabStates';
import { LandmarkCard, type LandmarkEdit } from './LandmarkCard';
import {
  type Asker,
  askKicker,
  formatDistance,
  kindWord,
  type LandmarkRow,
  litId,
  type PlaceAsk,
  type PlaceNameAsk,
  type PlacesData,
  type ProposalAsk,
  rowsOf,
  selectedLandmark,
} from './placesModel';

/**
 * Body › Places (board 5.4.3), the default view: what is asked of the body's places, then its
 * landmarks — the list reads as the map's key, and a row selects its landmark, which opens on the
 * inset card (board 5.4.3 | Landmark). The lit item is the frame's (controlled): a landmark, or an
 * ask the left column linked. A row's hover is the view's own until the frame's contract carries a
 * hovered item to its marker (a contract request).
 *
 * Each list is in its read's state: a skeleton while it loads, *Couldn't be read* where it failed
 * (the tab's note names what failed, with *Try again*), and a count that says when its read
 * stopped short ("400+"). Who asked is drawn only for a viewer who can see it.
 *
 * Every control is drawn only when its handler is passed (the wiring passes one only for a viewer
 * with the capability). The map's landmark tools (B01-6b) are the wiring's: dropping a landmark,
 * placing an emailed name and adding a skater's proposal open the drop card (`drop`), which stands
 * over the list in a landmark card's place; moving one and removing it are its card's.
 */

export type PlacesViewProps = {
  data: PlacesData | undefined;
  /** Ask again for every read that failed. */
  onRetry?: () => void;
  /** Tried again; the fresh answers aren't in. */
  retryPending?: boolean;
  lit?: string | null;
  onLitChange?: (id: string | null) => void;
  hovered?: string | null;
  onHoverChange?: (id: string | null) => void;
  /** The viewer may place landmarks (`body.places`): the map tools' entry points are drawn. */
  canPlace?: boolean;
  /** The emails' name is this landmark, spelled another way. */
  onFileAsSpelling?: (askId: string, landmarkId: string) => void;
  /** Dismiss the emails' name. Resolves whether it landed (a refusal is a toast). */
  onDismissName?: (
    askId: string,
    reason: CorpusNameDismissReason,
    note: string,
  ) => Promise<boolean>;
  /** Answer a proposal with the landmark already there. */
  onSamePlace?: (ask: ProposalAsk) => void;
  /** Decline a proposal; the skaters read the note. Resolves whether it landed. */
  onDecline?: (askId: string, note: string) => Promise<boolean>;
  /**
   * Save one change to a landmark (its card's fields save as they change); a promise, when given,
   * settles once the server has answered.
   */
  onEditLandmark?: (id: string, edit: LandmarkEdit) => unknown;
  /** Draw a landmark as a bay (the Shape tab's task); absent for a viewer who can't draw bays. */
  onDrawAsBay?: (id: string) => void;
  /** Drop a new landmark on the map (L): the wiring opens its card in `drop`. */
  onDropLandmark?: () => void;
  /** Place the emails' name on the map: the drop card, filled. */
  onPlaceName?: (ask: PlaceNameAsk) => void;
  /** Add a skater's proposal as a landmark: the drop card, filled, its point where they put it. */
  onAddProposal?: (ask: ProposalAsk) => void;
  /** The landmark being dropped, on its card over the list (the wiring's `LandmarkDrop`). */
  drop?: ReactNode;
  /** The landmark the map's point tool is moving. */
  moving?: string | null;
  /** Start or stop moving a landmark on the map. */
  onMoveLandmark?: (id: string) => void;
  /** Remove a landmark, with its reason. Resolves whether it landed. */
  onRemoveLandmark?: (id: string, reason: string) => Promise<boolean>;
};

/** A list's count on its rule: its length, a floor when its read stopped short, none until it lands. */
function listCount(list: PlacesData['asks'], capped: boolean) {
  if (!Array.isArray(list)) return {};
  return { count: { count: list.length, capped } };
}

/** A list's lines held while its read is on its way. */
function LoadingLines({ lines }: { lines: number }) {
  return (
    <span aria-hidden="true" className="flex flex-col gap-(--space-1_5)">
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <LoadingLine key={i} width="100%" />
      ))}
    </span>
  );
}

export function PlacesView({
  data,
  onRetry,
  retryPending = false,
  lit = null,
  onLitChange,
  hovered = null,
  onHoverChange,
  canPlace = false,
  onFileAsSpelling,
  onDismissName,
  onSamePlace,
  onDecline,
  onEditLandmark,
  onDrawAsBay,
  onDropLandmark,
  onPlaceName,
  onAddProposal,
  drop = null,
  moving = null,
  onMoveLandmark,
  onRemoveLandmark,
}: PlacesViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const dropping = drop != null;
  // The drop card stands where a landmark's card would: one card over the list at a time.
  const selected = dropping ? null : selectedLandmark(data, lit);
  const landmarks = data === undefined ? [] : rowsOf(data.landmarks);
  const canDrop = canPlace && onDropLandmark !== undefined;
  useTabKeys(root, [
    {
      key: 'L',
      run: () => onDropLandmark?.(),
      // Only while Drop a landmark is drawn: never while the tab loads (the inspector listens then
      // too), never under a card.
      enabled: canDrop && data !== undefined && selected === null && !dropping,
    },
  ]);
  // The card's way back hands focus to the row that opened it: the card leaving with focus inside
  // would drop it to the page, where none of the tab's keys answer.
  const returnTo = useRef<string | null>(null);
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId !== null || returnTo.current === null) return;
    const id = returnTo.current;
    returnTo.current = null;
    root.current?.querySelector<HTMLElement>(`[data-landmark-id="${CSS.escape(id)}"]`)?.focus();
  }, [selectedId]);
  if (data === undefined) {
    return (
      <TabBody aria-busy="true" data-slot="places-tab">
        <LoadingSection lines={4} />
        <LoadingSection lines={12} />
      </TabBody>
    );
  }
  return (
    <div ref={root} className="relative flex min-h-full flex-col" data-slot="places-tab">
      <TabBody
        data-dimmed={selected !== null || dropping ? '' : undefined}
        // Under a card, the list stays put behind it, dimmed and out of reach (Review 14 #7).
        className="transition-opacity duration-(--duration-fast) ease-standard data-dimmed:pointer-events-none data-dimmed:opacity-(--opacity-dim)"
        inert={selected !== null || dropping}
      >
        <ReadFailures failures={data.failures} onRetry={onRetry} pending={retryPending} />
        <Section
          title="Asked"
          {...listCount(data.asks, data.asksCapped)}
          aria-busy={data.asks === undefined || undefined}
          data-slot="asks"
        >
          {data.asks === undefined ? (
            <LoadingLines lines={3} />
          ) : isFailed(data.asks) ? (
            <CouldntRead />
          ) : (
            data.asks.length > 0 && (
              <ul className="flex flex-col">
                {data.asks.map((ask) => (
                  <AskRow
                    key={ask.id}
                    ask={ask}
                    lit={lit}
                    landmarks={landmarks}
                    canPlace={canPlace}
                    onFileAsSpelling={onFileAsSpelling}
                    onDismissName={onDismissName}
                    onSamePlace={onSamePlace}
                    onDecline={onDecline}
                    onPlaceName={onPlaceName}
                    onAddProposal={onAddProposal}
                  />
                ))}
              </ul>
            )
          )}
        </Section>
        <Section
          title="Landmarks"
          {...(Array.isArray(data.landmarks) ? { count: data.landmarks.length } : {})}
          aria-busy={data.landmarks === undefined || undefined}
          data-slot="landmarks"
          end={
            canDrop ? (
              <Button
                size="sm"
                data-slot="drop-landmark"
                // A drop under way keeps its button on (the board).
                aria-pressed={dropping}
                onClick={onDropLandmark}
              >
                Drop a landmark
                <Kbd variant="dim" aria-hidden="true">
                  L
                </Kbd>
              </Button>
            ) : undefined
          }
        >
          {data.landmarks === undefined ? (
            <LoadingLines lines={12} />
          ) : isFailed(data.landmarks) ? (
            <CouldntRead />
          ) : (
            data.landmarks.length > 0 && (
              <ul className="flex flex-col" aria-label="Landmarks">
                {data.landmarks.map((l) => (
                  <LandmarkListRow
                    key={l.id}
                    landmark={l}
                    selected={selected?.id === l.id}
                    hovered={hovered === litId.landmark(l.id)}
                    onSelect={onLitChange ? () => onLitChange(litId.landmark(l.id)) : undefined}
                    onHover={onHoverChange}
                  />
                ))}
              </ul>
            )
          )}
        </Section>
      </TabBody>
      {drop}
      {selected !== null && (
        <LandmarkCard
          key={selected.id}
          landmark={selected}
          canPlace={canPlace}
          onBack={() => {
            returnTo.current = selected.id;
            onLitChange?.(null);
          }}
          onEdit={onEditLandmark ? (edit) => onEditLandmark(selected.id, edit) : undefined}
          onDrawAsBay={onDrawAsBay ? () => onDrawAsBay(selected.id) : undefined}
          moving={moving === selected.id}
          onMove={onMoveLandmark ? () => onMoveLandmark(selected.id) : undefined}
          onRemove={
            onRemoveLandmark ? (reason) => onRemoveLandmark(selected.id, reason) : undefined
          }
        />
      )}
    </div>
  );
}

/** A landmark's row: its mark, its name and kind's word, its catalogs; pressing it selects it. */
function LandmarkListRow({
  landmark: l,
  selected,
  hovered,
  onSelect,
  onHover,
}: {
  landmark: LandmarkRow;
  selected: boolean;
  hovered: boolean;
  onSelect: (() => void) | undefined;
  onHover: ((id: string | null) => void) | undefined;
}) {
  const content = (
    <>
      <PlaceMark kind={l.kind} glyph />
      <span className="flex min-w-0 items-baseline gap-(--space-2) whitespace-nowrap">
        <span className="truncate text-row text-fg1 group-data-hovered/lm:text-fg group-data-selected/lm:text-fg group-hover/lm:text-fg">
          {l.name}
        </span>
        <span className="text-assist text-fg3">{kindWord(l.kind)}</span>
      </span>
      <TagRun>
        {l.catalogs.map((c) => (
          <Tag key={c}>{c}</Tag>
        ))}
      </TagRun>
    </>
  );
  const row = cn(
    'group/lm relative grid h-(--space-5_5) w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-(--space-2_5) text-left',
    'border-0 border-b border-dotted border-line',
    // The wash reaches half into each gutter, as the list's hover does (a row that does something).
    'before:pointer-events-none before:absolute before:-inset-x-(--space-2_5) before:inset-y-0 before:content-[""]',
    'data-hovered:before:bg-lift-05 data-selected:before:bg-lift-08 data-selected:before:inset-ring data-selected:before:inset-ring-fg2',
  );
  return (
    <li className="[&:last-child>*]:border-b-0">
      {onSelect ? (
        <button
          type="button"
          data-slot="landmark-row"
          data-landmark-id={l.id}
          data-hovered={hovered ? '' : undefined}
          data-selected={selected ? '' : undefined}
          aria-pressed={selected}
          onClick={onSelect}
          onPointerEnter={() => onHover?.(litId.landmark(l.id))}
          onPointerLeave={() => onHover?.(null)}
          onFocus={() => onHover?.(litId.landmark(l.id))}
          onBlur={() => onHover?.(null)}
          className={cn(
            row,
            'cursor-pointer outline-none hover:before:bg-lift-05 focus-visible:before:bg-lift-05',
          )}
        >
          {content}
        </button>
      ) : (
        <div data-slot="landmark-row" className={row}>
          {content}
        </div>
      )}
    </li>
  );
}

function AskRow({
  ask,
  lit,
  landmarks,
  canPlace,
  onFileAsSpelling,
  onDismissName,
  onSamePlace,
  onDecline,
  onPlaceName,
  onAddProposal,
}: {
  ask: PlaceAsk;
  lit: string | null;
  landmarks: readonly LandmarkRow[];
  canPlace: boolean;
} & Pick<
  PlacesViewProps,
  | 'onFileAsSpelling'
  | 'onDismissName'
  | 'onSamePlace'
  | 'onDecline'
  | 'onPlaceName'
  | 'onAddProposal'
>) {
  return (
    <li
      data-slot="ask"
      {...litAttr(lit, litId.ask(ask))}
      className={cn(
        'flex flex-col gap-(--space-1) border-0 border-b border-dotted border-line py-(--space-2_5) first:pt-0 last:border-b-0 last:pb-0',
        LIT_ROW,
      )}
    >
      <span className="flex items-baseline justify-between gap-(--space-3) whitespace-nowrap">
        <span className="truncate text-body leading-list text-fg">“{ask.name}”</span>
        <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
          {askKicker(ask)}
        </span>
      </span>
      {ask.kind === 'proposal' && ask.similar !== null && (
        <span className="text-assist leading-list text-warn">
          Possibly {ask.similar.name}, {formatDistance(ask.similar.meters)} away
        </span>
      )}
      {ask.kind === 'proposal' && (
        <span className="flex flex-wrap items-baseline gap-x-(--space-2) gap-y-(--space-1)">
          <AskerLine asker={ask.asker} />
          <AskedLine at={ask.asked} />
        </span>
      )}
      <AskActions
        ask={ask}
        landmarks={landmarks}
        canPlace={canPlace}
        onFileAsSpelling={onFileAsSpelling}
        onDismissName={onDismissName}
        onSamePlace={onSamePlace}
        onDecline={onDecline}
        onPlaceName={onPlaceName}
        onAddProposal={onAddProposal}
      />
    </li>
  );
}

/**
 * Who asked first, in the lockup's place: the person, or what the read says instead — never a blank
 * where a name would be. A viewer who can't see who asks gets no line at all.
 */
function AskerLine({ asker }: { asker: Asker }) {
  if (asker === 'hidden') return null;
  if (asker === undefined) return <LoadingLine width="9rem" />;
  if (isFailed(asker)) return <span className={ASSIST}>Who asked couldn’t be read</span>;
  if (asker === 'erased') return <span className={ASSIST}>Asked from an account since erased</span>;
  // Every ask names its asker: `null` is an ask past what the askers' read covers, not one unrecorded.
  if (asker === null) return <span className={ASSIST}>Who asked: {NOT_RECORDED}</span>;
  return (
    <PersonLockup
      name={asker.name}
      handle={asker.handle}
      {...(asker.href !== undefined ? { href: asker.href } : {})}
    />
  );
}

/** When it was first asked, beside who asked — or that the read doesn't say. */
function AskedLine({ at }: { at: number | null }) {
  return (
    <span data-slot="ask-asked" className={ASSIST}>
      {at === null ? `Asked: ${NOT_RECORDED}` : `Asked ${statusDate(at)}`}
    </span>
  );
}

const ASSIST = 'text-assist leading-list text-fg3';

function AskActions({
  ask,
  landmarks,
  canPlace,
  onFileAsSpelling,
  onDismissName,
  onSamePlace,
  onDecline,
  onPlaceName,
  onAddProposal,
}: Omit<Parameters<typeof AskRow>[0], 'lit'>) {
  const [why, setWhy] = useState<CorpusNameDismissReason>('not_a_place');
  const buttons =
    ask.kind === 'place-name'
      ? [
          canPlace && onPlaceName && !ask.alreadyNamed && (
            <Button key="place" size="sm" onClick={() => onPlaceName(ask)}>
              Place it
            </Button>
          ),
          onFileAsSpelling && landmarks.length > 0 && (
            <DropdownMenu key="already">
              <DropdownMenuTrigger render={<Button size="sm" />}>
                {ask.alreadyNamed ? 'Which one' : 'Already here'}
                <DropdownMenuCaret />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {landmarks.map((l) => (
                  <DropdownMenuItem
                    key={l.id}
                    icon={<PlaceMark kind={l.kind} glyph />}
                    onClick={() => onFileAsSpelling(ask.id, l.id)}
                  >
                    {l.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ),
          onDismissName && (
            <ReasonAsk
              key="dismiss"
              trigger={<Button size="sm">Dismiss</Button>}
              title={`Dismiss “${ask.name}”`}
              description="It leaves the queue with this reason; it can be reopened."
              confirm="Dismiss"
              label="Note"
              optional
              placeholder="If the reason needs one"
              // The row keeps the note to the request note's cap (`corpusPlaceNames.dismiss` cuts it
              // there, silently), and its audit line quotes what was kept: held to it where typed.
              maxLength={MAX_REQUEST_NOTE_LENGTH}
              extra={
                <RadioGroup
                  aria-label="Why it isn’t a landmark"
                  value={why}
                  onValueChange={(v) => setWhy(v as CorpusNameDismissReason)}
                >
                  {CORPUS_NAME_DISMISS_REASONS.map((r) => (
                    <RadioRow key={r} value={r} label={CORPUS_NAME_DISMISS_LABELS[r]} />
                  ))}
                </RadioGroup>
              }
              onConfirm={(note) => onDismissName(ask.id, why, note)}
            />
          ),
        ]
      : [
          canPlace && onAddProposal && ask.existingLandmarkId === null && (
            <Button key="add" size="sm" onClick={() => onAddProposal(ask)}>
              Add
            </Button>
          ),
          onSamePlace && (ask.existingLandmarkId !== null || ask.similar !== null) && (
            <Button key="same" size="sm" onClick={() => onSamePlace(ask)}>
              Same place
            </Button>
          ),
          onDecline && (
            <ReasonAsk
              key="decline"
              trigger={<Button size="sm">Decline</Button>}
              title={`Decline “${ask.name}”`}
              description="The skaters who named it read your note."
              confirm="Decline"
              label="Note · the skaters read it"
              // The decline's note is the request's own, under its own cap.
              maxLength={MAX_REQUEST_NOTE_LENGTH}
              onConfirm={(note) => onDecline(ask.id, note)}
            />
          ),
        ];
  const shown = buttons.filter(Boolean);
  if (shown.length === 0) return null;
  return (
    <div className="mt-(--space-1_5) flex flex-wrap items-center gap-(--space-2)">{shown}</div>
  );
}

export type { LandmarkEdit, LandmarkKind };
