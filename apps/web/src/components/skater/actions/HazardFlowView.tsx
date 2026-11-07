import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowRotateLeft,
  faCamera,
  faCheck,
  faChevronDown,
  faMinus,
  faPlus,
  faXmark,
} from '@fortawesome/sharp-light-svg-icons';
import {
  DUPLICATE_NUDGE_CONFIRM,
  DUPLICATE_NUDGE_DISTINCT,
  HAZARD_TYPE_LABELS,
  HAZARD_TYPE_PRESETS,
  HAZARD_TYPES,
  type HazardType,
  isPassageMarker,
  shoreBandRefusalText,
} from '@skating/core';
import { type ComponentProps, type ReactNode, useId, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';
import { Textarea } from '@/components/kit/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { cn } from '@/lib/utils';
import type { HazardDraft, HazardDrawKind } from '@/stores/hazardDraftStore';

import { INK_PRIMARY } from '../styles';
import {
  DRAW_KIND_LABELS,
  drawKindsFor,
  postBlocker,
  replaceLabel,
  SHORE_TIP,
  shoreToggleLabel,
  sizeCopy,
  stepOf,
  whereLine,
} from './hazardFlowModel';

/**
 * The hazard flow's screen (boards 3.1–3.8), Convex-free: one column of questions that fills in as
 * it goes — what you saw, where it is, how big, photos and a note — with Post at the foot. The map
 * is the "where": while it's listening, the Where question carries the brackets and everything
 * else steps back. `HazardFlow` connects it.
 *
 * Copy records what a person saw; nothing on this screen says or implies that ice is safe (D3).
 */

export interface PhotoPreview {
  id: string;
  url: string;
  name: string;
}

export interface NudgeView {
  text: string;
}

export interface HazardFlowViewProps {
  draft: HazardDraft;
  photos: readonly PhotoPreview[];
  /** How many photos a restored draft had that didn't come back (`0` hides the note). */
  lostPhotos: number;
  nudge: NudgeView | null;
  error: string | null;
  submitting: boolean;
  /** A portal container for the tooltips (a story's themed quad); the body when absent. */
  container?: HTMLElement | null;
  onChooseType: (type: HazardType) => void;
  onClearType: () => void;
  onChooseDrawKind: (kind: HazardDrawKind) => void;
  onStopPlacing: () => void;
  onUndo: () => void;
  onFlipShore: () => void;
  onResize: (direction: 1 | -1) => void;
  onNoteChange: (note: string) => void;
  onAddPhotos: (files: File[]) => void;
  onRemovePhoto: (id: string) => void;
  onConfirmNearby: () => void;
  onFileDistinct: () => void;
  onPost: () => void;
  onCancel: () => void;
}

const OTHER_TYPES = HAZARD_TYPES.filter(
  (t) => !(HAZARD_TYPE_PRESETS as readonly string[]).includes(t) && !isPassageMarker(t),
);
const PASSAGE_TYPES = HAZARD_TYPES.filter((t) => isPassageMarker(t));

const PRESSABLE =
  'cursor-pointer rounded-control border border-solid border-line2 bg-transparent text-left text-fg1 outline-none transition-[background-color,border-color,color] duration-(--duration-fast) ease-standard hover:bg-lift-05 hover:text-fg focus-visible:shadow-focus disabled:cursor-default disabled:text-fg-disabled';

export function HazardFlowView(props: HazardFlowViewProps) {
  const { draft, photos, lostPhotos, nudge, error, submitting, container } = props;
  const step = stepOf(draft);
  const placing = draft.placing;
  const placed = step === 'details' || step === 'confirm';
  const blocker = postBlocker(draft);
  const tip = container !== undefined ? { container } : {};
  return (
    <div data-slot="hazard-flow" data-step={step} className="flex flex-col gap-(--space-4)">
      {lostPhotos > 0 && (
        <Note data-slot="hazard-restored">
          Your draft is back. The {lostPhotos === 1 ? 'photo' : `${lostPhotos} photos`} you added
          didn’t come with it — add {lostPhotos === 1 ? 'it' : 'them'} again if you still have{' '}
          {lostPhotos === 1 ? 'it' : 'them'}.
        </Note>
      )}
      {nudge && (
        <div
          data-slot="hazard-nudge"
          role="alert"
          className="flex flex-col gap-(--space-3) border border-solid border-line2 bg-raise p-(--space-3)"
        >
          <p className="m-0 text-row text-fg [text-wrap:pretty]">{nudge.text}</p>
          <div className="flex flex-wrap gap-(--space-2)">
            <Button
              variant="primary"
              size="sm"
              className={INK_PRIMARY}
              data-attr="hazard-confirm-nearby"
              disabled={submitting}
              onClick={props.onConfirmNearby}
            >
              <FontAwesomeIcon icon={faCheck} aria-hidden="true" />
              {DUPLICATE_NUDGE_CONFIRM}
            </Button>
            <Button
              size="sm"
              data-attr="hazard-file-distinct"
              disabled={submitting}
              onClick={props.onFileDistinct}
            >
              {DUPLICATE_NUDGE_DISTINCT}
            </Button>
          </div>
        </div>
      )}

      <Question title="What did you see?" done={draft.hazardType !== null} dim={placing}>
        {draft.hazardType ? (
          <div
            data-slot="hazard-chosen"
            className="flex items-center gap-(--space-2) rounded-control bg-fg py-(--space-1_5) ps-(--space-3) pe-(--space-1_5) text-row font-medium text-bg"
          >
            <span className="min-w-0 flex-1">{HAZARD_TYPE_LABELS[draft.hazardType]}</span>
            <Button
              variant="bare"
              size="icon-sm"
              className="bg-bg text-fg"
              aria-label="Pick a different type"
              data-attr="hazard-clear-type"
              onClick={props.onClearType}
            >
              <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <TypePicker onChoose={props.onChooseType} />
        )}
      </Question>

      <Question
        title="Where is it?"
        done={placed}
        dim={draft.hazardType === null}
        listening={placing}
      >
        {draft.hazardType !== null && <WhereBody {...props} />}
        {draft.hazardType === null && (
          <p className="m-0 text-assist text-fg3">{whereLine(draft)}</p>
        )}
      </Question>

      {draft.hazardType !== null && (draft.drawKind !== 'spot' || placed) && (
        <SizeQuestion
          draft={draft}
          placed={placed}
          dim={placing}
          tip={tip}
          onResize={props.onResize}
        />
      )}

      <Optional title="Photos" open={placed || photos.length > 0} dim={placing}>
        <PhotosBody photos={photos} onAdd={props.onAddPhotos} onRemove={props.onRemovePhoto} />
      </Optional>
      <Optional title="Anything worth adding?" open={placed || draft.note !== ''} dim={placing}>
        <Textarea
          aria-label="Anything worth adding?"
          className="ph-no-capture"
          data-attr="hazard-note"
          rows={3}
          value={draft.note}
          placeholder="Running the length of the narrows, water showing at the edges"
          onChange={(e) => props.onNoteChange(e.target.value)}
        />
      </Optional>

      {error && (
        <Note tone="warn" role="alert">
          {error}
        </Note>
      )}

      <div
        data-slot="hazard-flow-foot"
        className={cn(
          'flex items-center justify-between gap-(--space-2_5) border-0 border-t border-solid border-line pt-(--space-3)',
          placing && 'opacity-50',
        )}
      >
        <Button data-attr="hazard-cancel" disabled={submitting} onClick={props.onCancel}>
          Cancel
        </Button>
        {blocker !== null || nudge !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="primary"
                  className={cn(INK_PRIMARY, 'opacity-40')}
                  data-attr="hazard-post"
                  aria-disabled="true"
                  onClick={(e) => e.preventDefault()}
                />
              }
            >
              Post hazard
            </TooltipTrigger>
            <TooltipContent {...tip}>
              {blocker ?? 'Confirm the one already here, or say this is a different hazard'}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="primary"
            className={INK_PRIMARY}
            data-attr="hazard-post"
            loading={submitting}
            onClick={props.onPost}
          >
            Post hazard
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * One question: a small square that fills once it's answered, the title, then the body. While the
 * map is listening the Where question wears the brackets; the rest step back.
 */
function Question({
  title,
  done,
  dim = false,
  listening = false,
  aside,
  children,
}: {
  title: string;
  done: boolean;
  dim?: boolean;
  listening?: boolean;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      data-slot="hazard-question"
      data-listening={listening ? '' : undefined}
      className={cn(
        'relative flex flex-col gap-(--space-2_5)',
        dim && 'opacity-50',
        listening && 'outline outline-1 outline-offset-[6px] outline-acc',
      )}
    >
      <h3
        id={id}
        className="m-0 flex items-center gap-(--space-2) text-kick leading-none font-semibold tracking-head text-fg uppercase"
      >
        <span
          aria-hidden="true"
          className={cn('size-2 border border-solid border-fg2', done && 'border-fg bg-fg')}
        />
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

/** An optional question, folded to its title line until it's worth opening. */
function Optional({
  title,
  open,
  dim,
  children,
}: {
  title: string;
  open: boolean;
  dim: boolean;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  const shown = open || opened;
  const aside = (
    <span className="text-assist font-regular tracking-normal text-fg3 normal-case">Optional</span>
  );
  if (shown) {
    return (
      <Question title={title} done={false} dim={dim} aside={aside}>
        {children}
      </Question>
    );
  }
  return (
    <button
      type="button"
      data-slot="hazard-folded"
      aria-expanded="false"
      onClick={() => setOpened(true)}
      className={cn(
        'flex w-full cursor-pointer items-center gap-(--space-2) border-0 bg-transparent p-0 text-left outline-none focus-visible:shadow-focus',
        'text-kick leading-none font-semibold tracking-head text-fg uppercase',
        dim && 'opacity-50',
      )}
    >
      <span aria-hidden="true" className="size-2 border border-solid border-fg2" />
      {title}
      {aside}
      <FontAwesomeIcon icon={faChevronDown} aria-hidden="true" className="ms-auto h-2.5 text-fg3" />
    </button>
  );
}

/** What did you see (3.1): the three most-reported as tiles, every other danger, then a crossing. */
function TypePicker({ onChoose }: { onChoose: (type: HazardType) => void }) {
  return (
    <div className="flex flex-col gap-(--space-2_5)">
      <div className="grid grid-cols-3 gap-(--space-2)">
        {HAZARD_TYPE_PRESETS.map((type) => (
          <button
            key={type}
            type="button"
            data-attr={`hazard-type-${type}`}
            className={cn(
              PRESSABLE,
              'flex min-h-14 items-end px-(--space-3) py-(--space-2_5) text-row font-medium',
            )}
            onClick={() => onChoose(type)}
          >
            {HAZARD_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-(--space-1_5)">
        {OTHER_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            data-attr={`hazard-type-${type}`}
            className={cn(PRESSABLE, 'px-(--space-3) py-(--space-2) text-row')}
            onClick={() => onChoose(type)}
          >
            {HAZARD_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
      <p className="m-0 mt-(--space-2) flex items-center gap-(--space-3) text-kick leading-none font-medium tracking-head text-fg3 uppercase">
        Getting across
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
      </p>
      <div className="flex flex-col gap-(--space-1_5)">
        {PASSAGE_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            data-attr={`hazard-type-${type}`}
            className={cn(
              PRESSABLE,
              'flex flex-col gap-(--space-1) px-(--space-3) py-(--space-2) text-row',
            )}
            onClick={() => onChoose(type)}
          >
            {HAZARD_TYPE_LABELS[type]}
            <small className="text-assist text-fg3">A place you got across — not a danger</small>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where is it (3.2–3.6): the draw chips, what's placed, and the controls of the current mode. */
function WhereBody({
  draft,
  container,
  onChooseDrawKind,
  onStopPlacing,
  onUndo,
  onFlipShore,
}: HazardFlowViewProps) {
  const kinds = drawKindsFor(draft.hazardType);
  const replace = replaceLabel(draft);
  const tip = container !== undefined ? { container } : {};
  const n = draft.shape
    ? draft.shape.geometryKind === 'point_radius'
      ? draft.shape.coord
        ? 1
        : 0
      : draft.shape.vertices.length
    : 0;
  return (
    <div className="flex flex-col gap-(--space-2_5)">
      <fieldset className="m-0 flex flex-wrap gap-(--space-1_5) border-0 p-0">
        <legend className="mb-(--space-2_5) p-0 text-kick leading-none font-medium tracking-head text-fg3 uppercase">
          Draw it as
        </legend>
        {kinds.map((kind) => {
          const chip = (
            <DrawChip
              key={kind}
              kind={kind}
              on={draft.drawKind === kind}
              onClick={() => onChooseDrawKind(kind)}
            />
          );
          return kind === 'shore' ? (
            <Tooltip key={kind}>
              <TooltipTrigger render={chip}>{DRAW_KIND_LABELS[kind]}</TooltipTrigger>
              <TooltipContent {...tip}>{SHORE_TIP}</TooltipContent>
            </Tooltip>
          ) : (
            <DrawChip
              key={kind}
              kind={kind}
              on={draft.drawKind === kind}
              onClick={() => onChooseDrawKind(kind)}
            >
              {DRAW_KIND_LABELS[kind]}
            </DrawChip>
          );
        })}
      </fieldset>
      <div className="flex flex-wrap items-start gap-(--space-2_5) gap-x-(--space-3)">
        <p
          data-slot="hazard-where"
          aria-live="polite"
          className="m-0 min-w-[12rem] flex-1 text-row text-fg2 [text-wrap:pretty]"
        >
          {whereLine(draft)}
        </p>
        <div className="flex flex-wrap gap-(--space-1_5)">
          {draft.placing && draft.drawKind === 'line' && (
            <Button size="sm" data-attr="hazard-undo" disabled={n === 0} onClick={onUndo}>
              <FontAwesomeIcon icon={faArrowRotateLeft} aria-hidden="true" />
              Undo point
            </Button>
          )}
          {draft.placing && (draft.drawKind === 'line' || draft.drawKind === 'area') && (
            <Button
              size="sm"
              variant="primary"
              className={INK_PRIMARY}
              data-attr="hazard-done"
              onClick={onStopPlacing}
            >
              Done
            </Button>
          )}
          {draft.drawKind === 'shore' && draft.shore && draft.shore.taps.length === 2 && (
            <Tooltip>
              <TooltipTrigger
                render={<Button size="sm" data-attr="hazard-shore-flip" onClick={onFlipShore} />}
              >
                {shoreToggleLabel(draft.shore)}
              </TooltipTrigger>
              <TooltipContent {...tip}>
                {draft.shore.theOtherWay
                  ? 'Takes the shorter stretch of shore between your two clicks'
                  : 'Takes the longer way round the lake between your two clicks'}
              </TooltipContent>
            </Tooltip>
          )}
          {replace !== null && (
            <Button
              size="sm"
              data-attr="hazard-replace"
              onClick={() => draft.drawKind && onChooseDrawKind(draft.drawKind)}
            >
              {replace}
            </Button>
          )}
        </div>
      </div>
      {draft.shore?.refusal && (
        <Note tone="warn" role="alert">
          {shoreBandRefusalText(draft.shore.refusal)}
        </Note>
      )}
    </div>
  );
}

/** A "Draw it as" chip: a pressable that reads pressed while it's the way you're drawing. */
function DrawChip({
  kind,
  on,
  className,
  ...props
}: ComponentProps<'button'> & { kind: HazardDrawKind; on: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-attr={`hazard-draw-${kind}`}
      className={cn(
        PRESSABLE,
        'px-(--space-2_5) py-(--space-1_5) text-assist',
        on && 'border-fg bg-fg text-bg hover:bg-fg hover:text-bg',
        className,
      )}
      {...props}
    />
  );
}

function SizeQuestion({
  draft,
  placed,
  dim,
  tip,
  onResize,
}: {
  draft: HazardDraft;
  placed: boolean;
  dim: boolean;
  tip: { container?: HTMLElement | null };
  onResize: (direction: 1 | -1) => void;
}) {
  const copy = sizeCopy(draft);
  if (copy === null) return null;
  // The shore band's width is live as soon as the two ends are in, refused or not: narrowing is
  // the way out of the commonest refusal.
  const live = placed || (draft.drawKind === 'shore' && (draft.shore?.taps.length ?? 0) === 2);
  return (
    <Question title={copy.question} done={placed} dim={dim || !live}>
      <div className="flex items-center gap-(--space-2_5)">
        <Button
          size="icon-sm"
          aria-label={copy.narrower}
          data-attr="hazard-size-down"
          disabled={!live}
          onClick={() => onResize(-1)}
        >
          <FontAwesomeIcon icon={faMinus} aria-hidden="true" />
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-slot="hazard-size"
                aria-live="polite"
                className="min-w-0 flex-1 text-center text-row text-fg1"
              />
            }
          >
            {copy.value}
          </TooltipTrigger>
          <TooltipContent {...tip}>{copy.tip}</TooltipContent>
        </Tooltip>
        <Button
          size="icon-sm"
          aria-label={copy.wider}
          data-attr="hazard-size-up"
          disabled={!live}
          onClick={() => onResize(1)}
        >
          <FontAwesomeIcon icon={faPlus} aria-hidden="true" />
        </Button>
      </div>
    </Question>
  );
}

function PhotosBody({
  photos,
  onAdd,
  onRemove,
}: {
  photos: readonly PhotoPreview[];
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="ph-no-capture flex flex-wrap gap-(--space-2)">
      {photos.map((photo) => (
        <div key={photo.id} className="relative size-16 border border-solid border-line2">
          <img src={photo.url} alt="" className="block size-full object-cover" />
          <Button
            variant="bare"
            size="icon-xs"
            aria-label={`Remove ${photo.name}`}
            data-attr="hazard-photo-remove"
            className="absolute top-0 right-0 bg-panel"
            onClick={() => onRemove(photo.id)}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </Button>
        </div>
      ))}
      <button
        type="button"
        data-attr="hazard-photo-add"
        className={cn(
          PRESSABLE,
          'flex size-16 flex-col items-center justify-center gap-(--space-1) border-dashed text-assist',
        )}
        onClick={() => input.current?.click()}
      >
        <FontAwesomeIcon icon={faCamera} aria-hidden="true" />
        Add
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Add photos"
        data-testid="hazard-photo-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onAdd(files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
