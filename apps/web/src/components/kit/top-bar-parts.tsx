import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/sharp-regular-svg-icons';
import type { ComponentProps, CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import { AvatarStack, StackFace } from './avatar';
import { Badge } from './badge';
import { InputGroupIcon } from './input';
import { Kbd } from './kbd';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

/**
 * The console top bar's three parts (admin only): the season tape at its center, the search
 * trigger and the colleagues' faces at its right. The bar itself — its height, its rule, where
 * each part sits — is the app shell's.
 *
 * In go-mode every part dims (`dimmed`) while the rail's letters light.
 */

/** Go-mode's dim: the part steps back while the rail's letters light. */
const DIMMED = 'opacity-(--opacity-dim)';

// ── The season tape ──────────────────────────────────────────────────────────────────────────

type TapeMark = {
  /** Where on the season, from 0 (its first day) to 1 (its last). */
  at: number;
  /**
   * `event` — something the season did (a 2 px stroke); `now` — today (the white notch over the
   * tape); `ghost` — last season's same moment (a dashed hairline).
   */
  kind: 'event' | 'now' | 'ghost';
  /** An event's meaning: gray, ice (the watch — a water mark) or amber (needs a person). */
  tone?: 'default' | 'acc' | 'warn';
  /** The tip's caps title ("Ice watch opened"), written capitalized. */
  title: string;
  /** The tip's words ("3 Oct · 2 of 3 sentinels"). */
  detail: string;
};

type SeasonTapeProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The season's name ("Winter 2026–27"), light caps before the tape. */
  season: string;
  /** Month starts, as fractions of the season: the short ticks on the tape. */
  ticks?: readonly number[];
  /** The marks; each is a button with a real tooltip (never a `title`). */
  marks: readonly TapeMark[];
  /** The day count after the tape ("Day 10"), units written out; outlined, not a call to action. */
  badge?: string;
  /** Go-mode: the tape steps back. */
  dimmed?: boolean;
};

const MARK_TONE = { default: 'bg-fg2', acc: 'bg-acc', warn: 'bg-warn' } as const;

/**
 * Half a mark's hit area at most: 12 px, so a lone mark is a 24 px target (with the tape's hit pad
 * above and below, 26 px tall on the console). Marks closer than that split the gap between them at
 * the midpoint, so no two hit areas overlap and each tip belongs to the mark under the pointer.
 */
const HIT_HALF = 'var(--space-3)';

/** A mark's hit area as insets from the tape's edges, clipped at the midpoints to its neighbors. */
function hitInsets(at: number, prev: number | undefined, next: number | undefined): CSSProperties {
  const p = at * 100;
  const left = `calc(${p}% - ${HIT_HALF})`;
  const right = `calc(${100 - p}% - ${HIT_HALF})`;
  return {
    left: prev === undefined ? left : `max(${left}, ${((prev + at) / 2) * 100}%)`,
    right: next === undefined ? right : `max(${right}, ${100 - ((at + next) / 2) * 100}%)`,
  };
}

/** The drawing of one mark, centered on its place (a stroke, so px). */
function MarkDrawing({ mark }: { mark: TapeMark }) {
  const left = { left: `${mark.at * 100}%` };
  if (mark.kind === 'now')
    return (
      <span
        data-slot="tape-now"
        style={left}
        className={cn(
          'absolute top-0 size-0 -translate-x-1/2',
          'border-x-(length:--stroke-now) border-t-(length:--stroke-tick) border-solid border-x-transparent border-t-fg',
        )}
      />
    );
  if (mark.kind === 'ghost')
    return (
      <span
        data-slot="tape-ghost"
        style={left}
        className="absolute top-[0.1875rem] h-[0.5625rem] w-0 border-l border-dashed border-fg3"
      />
    );
  return (
    <span
      data-slot="tape-event"
      data-tone={mark.tone ?? 'default'}
      style={left}
      className={cn(
        'absolute top-[0.1875rem] h-[0.5625rem] w-(--stroke-note) -translate-x-1/2',
        MARK_TONE[mark.tone ?? 'default'],
      )}
    />
  );
}

/**
 * The season tape — the console's clock on every page: the season's name in light caps, a 240 px
 * hairline with a tick at each month, the season's marks on it, and the day badge.
 *
 * Every mark is a real button with a kit Tooltip (title, then the words), so hover and keyboard
 * focus both reach it; the tape is not navigation, so tips are allowed. A tape mark records what
 * happened or where today sits — never what the ice will do.
 */
function SeasonTape({
  season,
  ticks = [],
  marks,
  badge,
  dimmed = false,
  className,
  ...props
}: SeasonTapeProps) {
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  return (
    <div
      data-slot="season-tape"
      data-dimmed={dimmed ? '' : undefined}
      className={cn('flex items-center gap-(--space-3)', dimmed && DIMMED, className)}
      {...props}
    >
      <span
        data-slot="tape-season"
        className="text-assist leading-none font-light tracking-head whitespace-nowrap text-fg2 uppercase"
      >
        {season}
      </span>
      <TooltipProvider>
        {/* biome-ignore lint/a11y/useSemanticElements: a run of marks on a timeline, not a form — a named group, never a fieldset. */}
        <div
          role="group"
          aria-label={season}
          data-slot="tape"
          className="relative h-[0.875rem] w-tape shrink-0"
        >
          <span
            aria-hidden="true"
            data-slot="tape-base"
            className="absolute inset-x-0 top-[0.4375rem] h-(--stroke-hair) bg-line2"
          />
          {ticks.map((at) => (
            <span
              key={at}
              aria-hidden="true"
              data-slot="tape-tick"
              style={{ left: `${at * 100}%` }}
              className="absolute top-[0.3125rem] h-[0.3125rem] w-(--stroke-hair) bg-fg3"
            />
          ))}
          {sorted.map((mark, i) => (
            <Tooltip key={`${mark.kind}-${mark.at}-${mark.title}`}>
              <TooltipTrigger
                data-slot="tape-mark"
                data-kind={mark.kind}
                aria-label={`${mark.title}, ${mark.detail}`}
                style={hitInsets(mark.at, sorted[i - 1]?.at, sorted[i + 1]?.at)}
                render={<button type="button" />}
                className={cn(
                  'absolute -inset-y-(--gap-hit-y) cursor-default bg-transparent p-0 outline-none',
                  'focus-visible:shadow-focus',
                  // The current mark sits over its neighbors' drawings.
                  mark.kind === 'now' && 'z-(--z-raised)',
                )}
              />
              <TooltipContent title={mark.title} side="bottom">
                {mark.detail}
              </TooltipContent>
            </Tooltip>
          ))}
          <span aria-hidden="true" className="pointer-events-none absolute inset-0">
            {sorted.map((mark) => (
              <MarkDrawing key={`${mark.kind}-${mark.at}-${mark.title}`} mark={mark} />
            ))}
          </span>
        </div>
      </TooltipProvider>
      {badge !== undefined && (
        <Badge data-slot="tape-badge" className="bg-transparent text-fg2 inset-ring inset-ring-fg3">
          {badge}
        </Badge>
      )}
    </div>
  );
}

// ── The search trigger ───────────────────────────────────────────────────────────────────────

type SearchTriggerProps = Omit<ComponentProps<'button'>, 'children'> & {
  /** What the search finds, as its placeholder and name. */
  label?: string;
  /** The key that opens it, as the cap shows it. */
  shortcut?: string;
  /** The same key for a reader (`aria-keyshortcuts`). */
  keyshortcuts?: string;
  /** Go-mode: the search steps back. */
  dimmed?: boolean;
};

/**
 * The top bar's search: **a button dressed as the underline input** — the 13 px magnifier, the
 * placeholder in the quiet ink, the ⌘K cap at the rule's end — that opens the command palette.
 * It's a button because it holds no text of its own; typing happens in the palette. Hover and
 * focus are one look, the input's focus: the rule turns bright and doubles. It is as wide as its
 * words, so the placeholder never truncates where there is room for it (the console's top bar);
 * a caller that sets a width (`w-full`) gets that width.
 */
function SearchTrigger({
  label = 'Jump to a body or a person',
  shortcut = '⌘K',
  keyshortcuts = 'Meta+K',
  dimmed = false,
  className,
  ...props
}: SearchTriggerProps) {
  return (
    <button
      type="button"
      data-slot="search-trigger"
      data-dimmed={dimmed ? '' : undefined}
      aria-haspopup="dialog"
      aria-keyshortcuts={keyshortcuts}
      className={cn(
        'flex h-btn-sm w-max max-w-full min-w-0 shrink items-center gap-(--space-2) bg-transparent px-0 pb-(--space-0_5) text-left outline-none',
        'border-0 border-b border-solid border-line2 rounded-none',
        'text-assist leading-none font-regular text-fg3',
        'transition-[border-color,box-shadow,color,opacity] duration-(--duration-fast) ease-standard',
        'lit:border-fg lit:text-fg2 lit:shadow-[0_1px_0_0_var(--fg)]',
        dimmed && DIMMED,
        className,
      )}
      {...props}
    >
      <InputGroupIcon data-slot="search-icon">
        <FontAwesomeIcon icon={faMagnifyingGlass} />
      </InputGroupIcon>
      <span data-slot="search-label" className="min-w-0 flex-1 truncate">
        {label}
      </span>
      <Kbd data-slot="search-kbd" variant="dim" aria-hidden="true">
        {shortcut}
      </Kbd>
    </button>
  );
}

// ── The colleagues' faces ────────────────────────────────────────────────────────────────────

type Colleague = {
  /** Who it is, to tell them apart (and to leave the viewer out). */
  id: string;
  /** Their real name. */
  name: string;
  src?: string;
  /** On a console page right now (lit); otherwise idle (dim, solid). */
  present?: boolean;
};

type ColleagueFacesProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** Staff on the console. The viewer may be among them; they're left out. */
  people: readonly Colleague[];
  /** The viewer's id: never drawn here (the rail's foot already shows who you are). */
  viewerId?: string;
  /** Faces before the rest fold into "+N". */
  max?: number;
  /** What the run is: its accessible name and the tip's title. */
  label?: string;
  /** Go-mode: the faces step back. */
  dimmed?: boolean;
};

/**
 * The colleagues on the console with you: the kit's stacked faces, the present ones lit and over
 * the idle, which sit under them drawn solid but dim. **Never the viewer.** Nobody else on means no
 * run at all — never an empty "nobody" state. Hover or focus shows who, in a tip.
 */
function ColleagueFaces({
  people,
  viewerId,
  max = 4,
  label = 'Also here',
  dimmed = false,
  className,
  ...props
}: ColleagueFacesProps) {
  const others = people.filter((p) => p.id !== viewerId);
  if (others.length === 0) return null;
  // The tip reads present first, as the stack does.
  const ordered = [...others.filter((p) => p.present), ...others.filter((p) => !p.present)];
  const said = ordered.map((p) => (p.present ? p.name : `${p.name} (idle)`)).join(', ');
  return (
    <div
      data-slot="colleague-faces"
      data-dimmed={dimmed ? '' : undefined}
      className={cn('inline-flex', dimmed && DIMMED, className)}
      {...props}
    >
      <Tooltip>
        <TooltipTrigger
          aria-label={`${label}: ${said}`}
          render={<button type="button" />}
          className="inline-flex cursor-default rounded-full bg-transparent p-0 outline-none focus-visible:shadow-focus"
        >
          <AvatarStack label={label} max={max} aria-hidden="true">
            {others.map((p) => (
              <StackFace
                key={p.id}
                name={p.name}
                present={p.present ?? false}
                {...(p.src !== undefined ? { src: p.src } : {})}
              />
            ))}
          </AvatarStack>
        </TooltipTrigger>
        <TooltipContent title={label} side="bottom" align="end">
          {ordered.map((p) => (
            <span key={p.id} data-slot="colleague-line" className="block">
              {p.present ? p.name : `${p.name} · Idle`}
            </span>
          ))}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export {
  type Colleague,
  ColleagueFaces,
  type ColleagueFacesProps,
  SearchTrigger,
  type SearchTriggerProps,
  SeasonTape,
  type SeasonTapeProps,
  type TapeMark,
};
