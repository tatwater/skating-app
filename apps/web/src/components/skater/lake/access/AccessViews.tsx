import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faCamera,
  faDiamondTurnRight,
  faTriangleExclamation,
  faXmark,
} from '@fortawesome/sharp-light-svg-icons';
import {
  ACCESS_ALERT_REASONS,
  ACCESS_REASON_LABELS,
  type AccessAlertReason,
  accessAlertVoteControls,
  describePostedAccess,
  describePostedAccessNow,
  MAX_ACCESS_PHOTOS,
  POSTED_ACCESS_TIMEZONE,
  postedAccessStateAt,
} from '@skating/core';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button, buttonVariants } from '@/components/kit/button';
import { Field, FieldLabel } from '@/components/kit/input';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/kit/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/kit/select';
import { Textarea } from '@/components/kit/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
import { cn } from '@/lib/utils';

import { TermList } from '../AboutTab';
import type {
  AccessAlertModel,
  DerivedPutInModel,
  PostedTarget,
  PutInCardModel,
} from './accessModel';

/**
 * The Getting there tab's views, props only (board 1.8). One card per put-in: what to do, how far
 * the walk is (kept apart from any drive), what the signs say, what's at the lot, the live access
 * alerts with their votes, the photos, and directions. The card's corner button reports an access
 * problem (its popover opens from it); the full-width button at its foot is directions.
 *
 * Nothing on a card says the ice is reachable or safe (D3) — a way in is a fact about land.
 */

type Container = { container?: HTMLElement | null | undefined };

const portal = (container: HTMLElement | null | undefined) =>
  container !== undefined && container !== null ? { container } : {};

// ── Posted rules ──────────────────────────────────────────────────────────────────────────────

/**
 * Re-render once a minute so "Closed now · opens 6:42 AM" doesn't go stale in an open tab. Every
 * value it drives is rendered to the minute; no interval at all without a rule.
 */
function useMinuteTick(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

/**
 * What a sign says and what it means right now — the rule (verifiable against the sign) over its
 * consequence at this minute. Core's words (`describePostedAccess`, `describePostedAccessNow`).
 * It annotates and never suppresses: nothing here disables anything.
 */
export function PostedLines({
  targets,
  nowMs,
}: {
  targets: readonly PostedTarget[];
  nowMs?: number;
}) {
  const ruled = targets.filter((t) => t.rule !== undefined);
  const tick = useMinuteTick(ruled.length > 0 && nowMs === undefined);
  const now = nowMs ?? tick;
  const lines = ruled.flatMap((t) => {
    // biome-ignore lint/style/noNonNullAssertion: filtered above.
    const rule = t.rule!;
    const described = describePostedAccess(rule);
    if (!described) return [];
    const state = postedAccessStateAt(rule, {
      nowMs: now,
      lat: t.coord.lat,
      lon: t.coord.lng,
      timeZone: POSTED_ACCESS_TIMEZONE,
    });
    return [
      {
        described,
        now: describePostedAccessNow(state, POSTED_ACCESS_TIMEZONE),
        closed: !state.open,
        permit: rule.permitRequired === true,
      },
    ];
  });
  if (lines.length === 0) return <span className="text-fg2">No posted rules on file</span>;
  return (
    <span className="flex flex-col gap-(--space-1)">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the launch's sign, then its lot's — fixed order.
        <span key={i} className="flex flex-col">
          <span className={cn(l.permit ? 'text-warn' : 'text-fg1')}>{l.described}</span>
          {l.now && <span className={cn(l.closed ? 'text-warn' : 'text-fg')}>{l.now}</span>}
        </span>
      ))}
    </span>
  );
}

// ── Alerts ────────────────────────────────────────────────────────────────────────────────────

/**
 * A live access alert on this launch or its lot, with the community's two answers. Confirming
 * resets its clock; two "It's open" resolve it — being wrong about a gate costs a drive either way.
 * A moderator's pinned alert takes no votes.
 */
export function AccessAlertBox({
  alert,
  busy,
  error,
  onVote,
  onRetract,
}: {
  alert: AccessAlertModel;
  busy: boolean;
  error: string | null;
  onVote: ((verdict: 'still_blocked' | 'open') => void) | null;
  /** A moderator's retract ("this never existed"); `null` for everyone else. */
  onRetract: (() => void) | null;
}) {
  return (
    <div
      data-slot="access-alert"
      className="flex flex-col gap-(--space-2_5) border-0 border-l-2 border-solid border-warn bg-warn-wash px-(--space-3) py-(--space-2_5)"
    >
      <p className="m-0 text-row text-fg1 [text-wrap:pretty]">
        <span className="font-semibold text-warn">{alert.reason}</span> — {alert.when}
        {alert.official && <span className="text-fg2"> · confirmed by a moderator</span>}
      </p>
      {alert.note && <p className="m-0 text-assist text-fg2 [text-wrap:pretty]">{alert.note}</p>}
      {(onVote || onRetract) && (
        <div className="flex flex-wrap gap-(--space-2)">
          {onVote && accessAlertVoteControls(alert).stillBlocked && (
            <Button
              size="sm"
              disabled={busy}
              data-attr="access-alert-still-blocked"
              onClick={() => onVote('still_blocked')}
            >
              Still blocked
            </Button>
          )}
          {/* A pin takes no votes — except its author's own "it's open" (D248). */}
          {onVote && accessAlertVoteControls(alert).open && (
            <Button
              size="sm"
              disabled={busy}
              data-attr="access-alert-open"
              onClick={() => onVote('open')}
            >
              It’s open
            </Button>
          )}
          {onRetract && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              data-attr="access-alert-retract"
              onClick={onRetract}
            >
              Retract
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-assist text-warn">
          {error}
        </p>
      )}
    </div>
  );
}

// ── Photos ────────────────────────────────────────────────────────────────────────────────────

export interface AccessPhotoModel {
  id: string;
  thumbUrl: string | null;
}

/**
 * Photos of a launch — "is this the right dirt road?" Infrastructure, not conditions, so they
 * outlive the season. The Add tile picks files; up to {@link MAX_ACCESS_PHOTOS} per access point.
 */
export function AccessPhotoStrip({
  name,
  photos,
  uploading,
  error,
  onAdd,
  onRemove,
}: {
  name: string;
  photos: readonly AccessPhotoModel[];
  uploading: boolean;
  error: string | null;
  onAdd: ((files: FileList) => void) | null;
  onRemove: ((id: string) => void) | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const room = photos.length < MAX_ACCESS_PHOTOS;
  return (
    <div data-slot="access-photos" className="flex flex-col gap-(--space-2)">
      <span className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase">
        Photos — {name}
      </span>
      <ul className="m-0 flex list-none flex-wrap gap-(--space-1_5) p-0">
        {photos.map((photo) => (
          <li
            key={photo.id}
            className="relative h-14 w-18 border border-solid border-line bg-raise"
          >
            {photo.thumbUrl && (
              <img src={photo.thumbUrl} alt={`At ${name}`} className="size-full object-cover" />
            )}
            {onRemove && (
              <Button
                variant="bare"
                size="icon-xs"
                aria-label="Remove photo"
                className="absolute top-0 right-0 bg-panel"
                onClick={() => onRemove(photo.id)}
              >
                <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
              </Button>
            )}
          </li>
        ))}
        {onAdd && room && (
          <li>
            <button
              type="button"
              data-attr="access-photo-add"
              aria-busy={uploading || undefined}
              disabled={uploading}
              onClick={() => input.current?.click()}
              className={cn(
                'flex h-14 w-18 cursor-pointer flex-col items-center justify-center gap-(--space-1) rounded-control',
                'border border-dashed border-line2 bg-transparent text-fg2 outline-none',
                'text-kick leading-none font-semibold tracking-label uppercase',
                'hover:text-fg focus-visible:shadow-focus disabled:cursor-progress',
              )}
            >
              <FontAwesomeIcon icon={faCamera} aria-hidden="true" className="h-[1.1em]" />
              {uploading ? 'Adding' : 'Add'}
            </button>
            <input
              ref={input}
              type="file"
              accept="image/*"
              multiple
              hidden
              aria-label={`Add photos of ${name}`}
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) onAdd(e.target.files);
                e.target.value = '';
              }}
            />
          </li>
        )}
      </ul>
      {!room && (
        <p className="m-0 text-assist text-fg3">
          {MAX_ACCESS_PHOTOS} photos is the limit for one access point.
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-assist text-warn">
          {error}
        </p>
      )}
    </div>
  );
}

// ── Directions ────────────────────────────────────────────────────────────────────────────────

export function DirectionsLink({
  directions,
  onOpen,
  container,
}: {
  directions: PutInCardModel['directions'];
  onOpen: () => void;
} & Container) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={directions.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onOpen}
            data-attr={`directions-${directions.target === 'parking' ? 'parking' : 'put-in'}`}
            className={cn(buttonVariants({ size: 'sm' }), 'w-full')}
          />
        }
      >
        <FontAwesomeIcon icon={faDiamondTurnRight} aria-hidden="true" className="h-[1.05em]" />
        {directions.label}
        <FontAwesomeIcon
          icon={faArrowUpRightFromSquare}
          aria-hidden="true"
          className="h-[0.85em] text-fg2"
        />
        <span className="sr-only">(opens in a new tab)</span>
      </TooltipTrigger>
      <TooltipContent {...portal(container)}>{directions.tip}</TooltipContent>
    </Tooltip>
  );
}

// ── Report an access problem ──────────────────────────────────────────────────────────────────

/**
 * The quick path for an access problem: a popover from the card's corner button, to the right of
 * it (over the map). The reasons are the blocking kinds — core's `ACCESS_ALERT_REASONS`.
 */
export function AccessProblemPopover({
  putInName,
  onPost,
  defaultOpen = false,
  container,
}: {
  putInName: string;
  onPost: ((reason: AccessAlertReason, note: string | undefined) => Promise<unknown>) | null;
  defaultOpen?: boolean;
} & Container) {
  const [open, setOpen] = useState(defaultOpen);
  const [reason, setReason] = useState<AccessAlertReason>('not_plowed');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const items = Object.fromEntries(ACCESS_ALERT_REASONS.map((r) => [r, ACCESS_REASON_LABELS[r]]));

  const post = () => {
    if (!onPost) return;
    setBusy(true);
    setError(null);
    onPost(reason, note.trim() || undefined)
      .then(() => {
        setOpen(false);
        setNote('');
      })
      .catch(() => setError('Could not send that. Try again.'))
      .finally(() => setBusy(false));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-sm"
                  aria-label={`Report an access problem at ${putInName}`}
                  data-attr="access-problem-open"
                  disabled={onPost === null}
                  className={cn('shrink-0', open && 'inset-ring-fg text-fg')}
                />
              }
            />
          }
        >
          <FontAwesomeIcon icon={faTriangleExclamation} aria-hidden="true" className="h-[1em]" />
        </TooltipTrigger>
        <TooltipContent {...portal(container)}>Report an access problem</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={12}
        className="w-[21rem]"
        {...portal(container)}
      >
        <div className="flex flex-col gap-(--space-3_5) p-(--space-4)">
          <div className="flex items-start gap-(--space-3)">
            <div className="flex min-w-0 flex-1 flex-col gap-(--space-2)">
              <PopoverTitle>Report an access problem</PopoverTitle>
              <PopoverDescription>{putInName}</PopoverDescription>
            </div>
            <PopoverClose render={<Button variant="bare" size="icon-xs" aria-label="Close" />}>
              <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
            </PopoverClose>
          </div>
          <Field>
            <FieldLabel>What’s the problem?</FieldLabel>
            <Select
              items={items}
              value={reason}
              onValueChange={(v) => v && setReason(v as AccessAlertReason)}
            >
              <SelectTrigger aria-label="What’s the problem?" data-attr="access-problem-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent {...portal(container)}>
                {ACCESS_ALERT_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ACCESS_REASON_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-col gap-(--space-1_5)">
            <label
              htmlFor={noteId}
              className="text-kick leading-none font-medium tracking-kick text-fg3 uppercase"
            >
              Note
            </label>
            <Textarea
              id={noteId}
              rows={2}
              value={note}
              placeholder="Anything else worth knowing (optional)"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="m-0 text-assist text-warn">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-(--space-2)">
            <PopoverClose render={<Button size="sm" />}>Cancel</PopoverClose>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              data-attr="access-problem-post"
              onClick={post}
            >
              Post
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── The cards ─────────────────────────────────────────────────────────────────────────────────

/** The put-in mark, as the map draws it: an accent square with a dark center, on the ground. */
function PutInMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 22 22" className="mt-px size-[1.375rem] shrink-0">
      <rect x="2" y="2" width="18" height="18" className="fill-bg" />
      <rect x="4" y="4" width="14" height="14" className="fill-acc" />
      <circle cx="11" cy="11" r="2.6" className="fill-bg" />
    </svg>
  );
}

/** A card's frame: square, a hairline; the recommended way in carries the accent edge. */
function CardFrame({
  label,
  recommended = false,
  children,
}: {
  label: string;
  recommended?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      aria-label={label}
      data-slot="put-in-card"
      data-recommended={recommended || undefined}
      className={cn(
        'flex flex-col gap-(--space-3) border border-solid border-line p-(--space-3_5)',
        recommended && 'border-line2 shadow-[inset_2px_0_0_var(--acc)]',
      )}
    >
      {children}
    </article>
  );
}

function CardHead({ name, sub, action }: { name: string; sub: string; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-(--space-3)">
      <PutInMark />
      <div className="flex min-w-0 flex-1 flex-col gap-(--space-0_5)">
        <h3 className="m-0 text-row font-medium text-fg">{name}</h3>
        <p className="m-0 text-assist text-fg2">{sub}</p>
      </div>
      {action}
    </div>
  );
}

export function PutInCard({
  card,
  problem,
  alerts,
  photos,
  onDirections,
  nowMs,
  container,
}: {
  card: PutInCardModel;
  /** The corner button and its popover. */
  problem: ReactNode;
  /** The live alerts, already connected. */
  alerts: ReactNode;
  /** The photo strip, already connected (or nothing). */
  photos: ReactNode;
  onDirections: () => void;
  /** Holds the posted rules' clock (stories). */
  nowMs?: number;
} & Container) {
  const facts = [
    ...(card.approach && !card.hikeIn ? [{ term: 'Approach', value: card.approach }] : []),
    {
      term: 'Posted',
      value: <PostedLines targets={card.posted} {...(nowMs !== undefined ? { nowMs } : {})} />,
    },
    { term: 'Here', value: card.here ?? 'No parking on file' },
  ];
  return (
    <CardFrame label={card.name} recommended={card.recommended}>
      <CardHead name={card.name} sub={card.sub} action={problem} />
      {card.lede && <p className="m-0 text-row text-fg1 [text-wrap:pretty]">{card.lede}</p>}
      {card.hikeIn && (
        // The walk stays its own line: a 55-minute drive and a 25-minute walk are never summed.
        <div data-slot="hike-in" className="flex flex-wrap items-center gap-(--space-2_5)">
          <Badge tone="warn">Hike-in</Badge>
          {card.approach && <span className="text-assist text-fg2">{card.approach}</span>}
        </div>
      )}
      <TermList rows={facts} />
      {alerts}
      {photos}
      <DirectionsLink directions={card.directions} onOpen={onDirections} container={container} />
    </CardFrame>
  );
}

/** A spot known only from reports: no row, so nothing to report against or photograph. */
export function DerivedPutInCard({
  model,
  onDirections,
  container,
}: {
  model: DerivedPutInModel;
  onDirections: () => void;
} & Container) {
  return (
    <CardFrame label="Where skaters put in">
      <CardHead name="Where skaters put in" sub={model.sub} />
      <DirectionsLink directions={model.directions} onOpen={onDirections} container={container} />
    </CardFrame>
  );
}

/** A lot no launch names — parking that serves the lake on its own. */
export function ParkingRow({
  name,
  line,
  directions,
  onDirections,
  container,
}: {
  name: string;
  line: string;
  directions: PutInCardModel['directions'];
  onDirections: () => void;
} & Container) {
  return (
    <li
      data-slot="parking-row"
      className="flex flex-col gap-(--space-2) border-0 border-b border-solid border-line py-(--space-3) last:border-b-0"
    >
      <span className="text-row font-medium text-fg">{name}</span>
      <span className="text-assist text-fg2">{line}</span>
      <DirectionsLink directions={directions} onOpen={onDirections} container={container} />
    </li>
  );
}

export { PutInMark };
