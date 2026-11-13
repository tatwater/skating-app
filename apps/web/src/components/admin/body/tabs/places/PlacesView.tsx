import {
  CORPUS_NAME_DISMISS_LABELS,
  CORPUS_NAME_DISMISS_REASONS,
  type CorpusNameDismissReason,
  type LandmarkKind,
} from '@skating/core';
import { useRef, useState } from 'react';
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
import { sayUnavailable, UnavailableButton } from '@/components/kit/unavailable-button';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';
import { ReasonAsk } from '../access/ReasonAsk';
import { LIT_ROW, LoadingSection, litAttr, TabBody } from '../tabParts';
import { LandmarkCard, type LandmarkEdit } from './LandmarkCard';
import {
  askKicker,
  formatDistance,
  kindWord,
  type LandmarkRow,
  litId,
  type PlaceAsk,
  type PlacesData,
  type ProposalAsk,
  selectedLandmark,
} from './placesModel';

/**
 * Body › Places (board 5.4.3), the default view: what is asked of the body's places, then its
 * landmarks — the list reads as the map's key, and a row selects its landmark, which opens on the
 * inset card (board 5.4.3 | Landmark). The lit item is the frame's (controlled): a landmark, or an
 * ask the left column linked. A row's hover is the view's own until the frame's contract carries a
 * hovered item to its marker (a contract request).
 *
 * Every control is drawn only when its handler is passed (the wiring passes one only for a viewer
 * with the capability). The map tools — placing a name, adding a proposal, dropping, moving or
 * removing a landmark, drawing one as a bay — are task modes not built yet: drawn as the board
 * draws them, they say so instead of acting.
 */

export type PlacesViewProps = {
  data: PlacesData | undefined;
  lit?: string | null;
  onLitChange?: (id: string | null) => void;
  hovered?: string | null;
  onHoverChange?: (id: string | null) => void;
  /** The viewer may place landmarks (`body.places`): the map tools' entry points are drawn. */
  canPlace?: boolean;
  /** The emails' name is this landmark, spelled another way. */
  onFileAsSpelling?: (askId: string, landmarkId: string) => void;
  /** Dismiss the emails' name. Resolves the refusal to show, or `null`. */
  onDismissName?: (
    askId: string,
    reason: CorpusNameDismissReason,
    note: string,
  ) => Promise<string | null>;
  /** Answer a proposal with the landmark already there. */
  onSamePlace?: (ask: ProposalAsk) => void;
  /** Decline a proposal; the skaters read the note. Resolves the refusal, or `null`. */
  onDecline?: (askId: string, note: string) => Promise<string | null>;
  /** Save one change to a landmark (its card's fields save as they change). */
  onEditLandmark?: (id: string, edit: LandmarkEdit) => void;
};

const MAP_TOOLS = {
  place: 'Placing an emailed name on the map comes with the map’s landmark tools.',
  add: 'Adding a skater’s proposal as a landmark comes with the map’s landmark tools.',
  drop: 'Dropping a landmark on the map comes with the map’s landmark tools.',
};

export function PlacesView({
  data,
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
}: PlacesViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const selected = selectedLandmark(data, lit);
  usePaneKeys(root, [
    { key: 'L', run: () => sayUnavailable(MAP_TOOLS.drop), enabled: canPlace && selected === null },
  ]);
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
        data-dimmed={selected !== null ? '' : undefined}
        // Under a card, the list stays put behind it, dimmed and out of reach (Review 14 #7).
        className="transition-opacity duration-(--duration-fast) ease-standard data-dimmed:pointer-events-none data-dimmed:opacity-(--opacity-dim)"
        inert={selected !== null}
      >
        <Section title="Asked" count={data.asks.length} data-slot="asks">
          {data.asks.length > 0 && (
            <ul className="flex flex-col">
              {data.asks.map((ask) => (
                <AskRow
                  key={ask.id}
                  ask={ask}
                  lit={lit}
                  landmarks={data.landmarks}
                  canPlace={canPlace}
                  onFileAsSpelling={onFileAsSpelling}
                  onDismissName={onDismissName}
                  onSamePlace={onSamePlace}
                  onDecline={onDecline}
                />
              ))}
            </ul>
          )}
        </Section>
        <Section
          title="Landmarks"
          count={data.landmarks.length}
          data-slot="landmarks"
          end={
            canPlace ? (
              <UnavailableButton size="sm" what={MAP_TOOLS.drop}>
                Drop a landmark
                <Kbd variant="dim" aria-hidden="true">
                  L
                </Kbd>
              </UnavailableButton>
            ) : undefined
          }
        >
          {data.landmarks.length > 0 && (
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
          )}
        </Section>
      </TabBody>
      {selected !== null && (
        <LandmarkCard
          key={selected.id}
          landmark={selected}
          canPlace={canPlace}
          onBack={() => onLitChange?.(null)}
          onEdit={onEditLandmark ? (edit) => onEditLandmark(selected.id, edit) : undefined}
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
}: {
  ask: PlaceAsk;
  lit: string | null;
  landmarks: readonly LandmarkRow[];
  canPlace: boolean;
} & Pick<PlacesViewProps, 'onFileAsSpelling' | 'onDismissName' | 'onSamePlace' | 'onDecline'>) {
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
      {ask.kind === 'proposal' && ask.asker !== null && (
        <PersonLockup name={ask.asker.name} handle={ask.asker.handle} />
      )}
      <AskActions
        ask={ask}
        landmarks={landmarks}
        canPlace={canPlace}
        onFileAsSpelling={onFileAsSpelling}
        onDismissName={onDismissName}
        onSamePlace={onSamePlace}
        onDecline={onDecline}
      />
    </li>
  );
}

function AskActions({
  ask,
  landmarks,
  canPlace,
  onFileAsSpelling,
  onDismissName,
  onSamePlace,
  onDecline,
}: Omit<Parameters<typeof AskRow>[0], 'lit'>) {
  const [why, setWhy] = useState<CorpusNameDismissReason>('not_a_place');
  const buttons =
    ask.kind === 'place-name'
      ? [
          canPlace && !ask.alreadyNamed && (
            <UnavailableButton key="place" size="sm" what={MAP_TOOLS.place}>
              Place it
            </UnavailableButton>
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
          canPlace && ask.existingLandmarkId === null && (
            <UnavailableButton key="add" size="sm" what={MAP_TOOLS.add}>
              Add
            </UnavailableButton>
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
