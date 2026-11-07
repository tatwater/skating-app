import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy } from '@fortawesome/sharp-regular-svg-icons';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { ScrollArea } from './scroll-area';
import { SwitchRow } from './switch';

/**
 * The kit's run log (the boards' `.logbox`) and run error block (`.runerr`).
 *
 * **Log** — a kit ScrollArea of mono lines, its thumb always drawn so a still render shows it
 * scrolls.
 * - **The live line rides a white rule**: while the run is writing, its last line carries the
 *   inset bar in the bright ink, a lift, and a cursor block. **A failing line is red-washed** with
 *   the bar in red.
 * - **Follow + Copy, split.** Follow (a bare switch, no key) shows only while the log is still
 *   being written; the copies are one split control at the right edge — *Copy log*, and a ▾ menu
 *   with *Copy warnings & errors* (and *Copy a diagnosis prompt*, when the caller can write one).
 *   Every copy is of every line, trimmed or not.
 * - **Following pauses when the reader scrolls up**, and Follow (switched back on) re-engages and
 *   jumps to the end. A finished log opens at its end.
 * - **Line heights are measured, not assumed**: a line wraps when it must, and lines out of view
 *   skip layout and paint (`content-visibility`) while keeping the size they last measured — so a
 *   few thousand lines stay cheap. Past `maxLines` (5,000) only the latest render, under a note.
 * - Nothing moves on its own beyond the jump to the end — no smooth scrolling — so reduced motion
 *   has nothing more to take away; the switch and buttons ride the motion tokens.
 *
 * **RunError** — what a failed run left: a red rule down the left edge on the red wash, a red
 * kicker head with an aside, the error in mono (its trace quieter), an optional body (the steps it
 * reached), and a foot with a note and the actions.
 */

type LogTone = 'ok' | 'warn' | 'bad' | 'stage';

/** One line of run output, as the runner wrote it. */
type LogLine = {
  id?: string | number;
  /** The clock time, in the quiet ink. */
  time?: string;
  /** A word after the time, toned: `ok` written, `warn`, `bad` fail, `stage` (the bright ink). */
  word?: string;
  tone?: LogTone;
  /** The rest, as written. */
  text: string;
  /** This is the line where the run failed: red-washed. */
  fail?: boolean;
};

/** What a copy holds: every line, or only the warnings and errors, or the diagnosis prompt. */
type LogCopy = 'log' | 'problems' | 'prompt';

type LogProps = Omit<ComponentProps<'div'>, 'children' | 'onCopy'> & {
  lines: readonly LogLine[];
  /** `live` while the run writes; `failed` red-washes the last line unless one is marked. */
  state: 'live' | 'finished' | 'failed';
  /** Following the end. Controlled with `onFollowChange`, else it starts on. */
  follow?: boolean;
  onFollowChange?: (follow: boolean) => void;
  /** Where a copy goes. Defaults to the clipboard. */
  onCopy?: (text: string, what: LogCopy) => void;
  /** Writes a prompt asking for a diagnosis of these lines; offers the copy when given. */
  diagnosis?: (lines: readonly LogLine[]) => string;
  /** How many of the latest lines render (every line is still copied). */
  maxLines?: number;
  /** The box's classes (its height). */
  boxClassName?: string;
};

const MAX_LINES = 5_000;

/** A line as text, the way the runner printed it. */
const lineText = (l: LogLine) => [l.time, l.word, l.text].filter((p) => p != null).join('  ');

const isProblem = (l: LogLine) => l.fail === true || l.tone === 'warn' || l.tone === 'bad';

const TONE: Record<LogTone, string> = {
  ok: 'text-fg1',
  warn: 'text-warn',
  bad: 'text-bad',
  stage: 'text-fg',
};

/** Within this of the end counts as at the end (sub-pixel scroll positions round). */
const END_SLACK_PX = 2;

/** The kit ScrollArea's scrolling element, inside its root. */
const viewportOf = (root: HTMLElement | null) =>
  root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

function writeClipboard(text: string) {
  // A refused clipboard (no focus, no permission) is the browser's to report, not a crash.
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function Log({
  lines,
  state,
  follow: followProp,
  onFollowChange,
  onCopy = writeClipboard,
  diagnosis,
  maxLines = MAX_LINES,
  className,
  boxClassName,
  'aria-label': ariaLabel = 'Run log',
  ...props
}: LogProps) {
  const [followState, setFollowState] = useState(true);
  const live = state === 'live';
  const follow = live && (followProp ?? followState);
  // Whether the view stays at the end: the handlers read it, so it's set the moment it changes,
  // not on the next render — a resize landing between the reader's scroll and the re-render can't
  // snap back. A live log sticks while it follows; any log sticks from the start (it opens at its
  // end, and late line measurements keep it there) until the reader scrolls away.
  const stick = useRef(true);
  if (live) stick.current = follow;
  const setFollow = useCallback(
    (next: boolean) => {
      stick.current = next;
      if (followProp === undefined) setFollowState(next);
      onFollowChange?.(next);
    },
    [followProp, onFollowChange],
  );

  const area = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toEnd = useCallback(() => {
    const v = viewportOf(area.current);
    if (v) v.scrollTop = v.scrollHeight;
  }, []);

  // Stay at the end as lines land and as lines out of view are measured.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new lines are what this follows
  useLayoutEffect(() => {
    if (stick.current) toEnd();
  }, [follow, lines, toEnd]);
  useEffect(() => {
    const box = content.current;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) toEnd();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [toEnd]);

  // The reader scrolling up lets go of the end — for a live log, Follow switches off.
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    const v = viewportOf(area.current);
    if (!v) return;
    const onScroll = () => {
      const atEnd = v.scrollHeight - v.scrollTop - v.clientHeight <= END_SLACK_PX;
      if (atEnd || !stick.current) return;
      if (liveRef.current) setFollow(false);
      else stick.current = false;
    };
    v.addEventListener('scroll', onScroll, { passive: true });
    return () => v.removeEventListener('scroll', onScroll);
  }, [setFollow]);

  const shown = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  const trimmed = lines.length - shown.length;
  const marked = shown.some((l) => l.fail);

  return (
    <div
      data-slot="log"
      data-state={state}
      className={cn('flex min-w-0 flex-col', className)}
      {...props}
    >
      <div
        data-slot="log-tools"
        className="mb-(--space-2) flex min-h-btn-sm items-center gap-(--space-3)"
      >
        {live && (
          <SwitchRow
            variant="bare"
            label="Follow"
            checked={follow}
            onCheckedChange={(next) => {
              setFollow(next);
              if (next) toEnd();
            }}
          />
        )}
        <CopyControl
          onCopy={(what) => {
            if (what === 'log') onCopy(lines.map(lineText).join('\n'), what);
            else if (what === 'problems')
              onCopy(lines.filter(isProblem).map(lineText).join('\n'), what);
            else if (diagnosis) onCopy(diagnosis(lines), what);
          }}
          prompt={diagnosis !== undefined}
        />
      </div>
      <ScrollArea
        ref={area}
        always
        className={cn('h-[16rem] border border-solid border-line bg-panel', boxClassName)}
        viewportClassName="py-(--space-2) pl-(--space-3_5)"
      >
        <div
          ref={content}
          role="log"
          aria-label={ariaLabel}
          aria-live="off"
          data-slot="log-lines"
          className="font-(family-name:--family-mono) text-mono-sm leading-(--lead-loose) text-fg2"
        >
          {trimmed > 0 && (
            <div
              data-slot="log-trimmed"
              className="border-0 border-b border-dotted border-line pb-(--space-1_5) mb-(--space-1_5) text-fg3"
            >
              Earlier lines are not shown · Copy log has every line
            </div>
          )}
          {shown.map((line, i) => {
            const last = i === shown.length - 1;
            const fail = line.fail === true || (state === 'failed' && last && !marked);
            const isLive = live && last && !fail;
            return (
              <div
                key={line.id ?? trimmed + i}
                data-slot="log-line"
                data-live={isLive ? '' : undefined}
                data-fail={fail ? '' : undefined}
                className={cn(
                  'whitespace-pre-wrap [overflow-wrap:anywhere]',
                  // Out of view, a line skips layout and keeps the size it last measured.
                  '[content-visibility:auto] [contain-intrinsic-block-size:auto_calc(var(--type-mono-sm)*var(--lead-loose))]',
                  // The bar and wash run to the box's left edge: the line bleeds the inset.
                  '-ml-(--space-3_5) pl-(--space-3_5)',
                  isLive && 'bg-lift-05 text-fg1 shadow-[inset_var(--stroke-note)_0_0_0_var(--fg)]',
                  fail && 'bg-bad-wash text-fg1 shadow-[inset_var(--stroke-note)_0_0_0_var(--bad)]',
                )}
              >
                {line.time != null && <span className="text-fg3">{line.time}</span>}
                {line.time != null && '  '}
                {line.word != null && (
                  <span data-slot="log-word" className={line.tone ? TONE[line.tone] : undefined}>
                    {line.word}
                  </span>
                )}
                {line.word != null && '  '}
                {line.text}
                {isLive && (
                  <span
                    data-slot="log-cursor"
                    aria-hidden="true"
                    className="ml-[0.4em] inline-block h-[1em] w-[0.45em] translate-y-[0.12em] bg-fg"
                  />
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

/** The split copy control: *Copy log*, and a ▾ menu of the other copies. Says *Copied* a moment. */
function CopyControl({ onCopy, prompt }: { onCopy: (what: LogCopy) => void; prompt: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = (what: LogCopy) => {
    onCopy(what);
    setCopied(true);
  };
  return (
    <span data-slot="log-copy" className="ml-auto inline-flex">
      <Button size="sm" onClick={() => copy('log')}>
        <FontAwesomeIcon icon={faCopy} aria-hidden="true" className="h-[1.1em]" />
        {/* Both labels share one cell, so the button keeps the longer one's width. */}
        <span className="grid">
          <span className={cn('col-start-1 row-start-1', copied && 'invisible')}>Copy log</span>
          <span
            aria-hidden={!copied}
            className={cn('col-start-1 row-start-1', !copied && 'invisible')}
          >
            Copied
          </span>
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            // One shared edge: the menu half overlaps the copy half by the hairline.
            <Button size="sm" aria-label="More ways to copy" className="-ml-px px-[0.6em]" />
          }
        >
          <DropdownMenuCaret />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => copy('problems')}>
            Copy warnings & errors
          </DropdownMenuItem>
          {prompt && (
            <DropdownMenuItem onClick={() => copy('prompt')}>
              Copy a diagnosis prompt
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  );
}

type RunErrorProps = Omit<ComponentProps<'section'>, 'title'> & {
  /** The head, as a red kicker ("Failed · Wed 14 Oct 04:12"). */
  title: ReactNode;
  /** A quiet note at the head's right ("3 / 3 tries spent"). */
  aside?: ReactNode;
  /** The error as thrown. */
  message: string;
  /** Where it was thrown, quieter, one line each. */
  trace?: readonly string[];
  /** A sentence at the foot's left. */
  note?: ReactNode;
  /** The foot's actions, at its right. */
  actions?: ReactNode;
};

function RunError({
  title,
  aside,
  message,
  trace = [],
  note,
  actions,
  className,
  children,
  ...props
}: RunErrorProps) {
  const id = useId();
  return (
    <section
      data-slot="run-error"
      aria-labelledby={id}
      className={cn(
        'flex flex-col gap-(--space-2_5) border-0 border-l-(length:--stroke-note) border-solid border-bad bg-bad-wash',
        'px-(--space-4) pt-(--space-3) pb-(--space-3_5)',
        className,
      )}
      {...props}
    >
      <div data-slot="run-error-head" className="flex items-baseline gap-(--space-3)">
        <h3
          id={id}
          className="m-0 text-kick leading-none font-semibold tracking-kick text-bad uppercase"
        >
          {title}
        </h3>
        {aside != null && (
          <span className="ml-auto text-kick leading-none font-medium tracking-micro text-fg3 uppercase">
            {aside}
          </span>
        )}
      </div>
      <pre
        data-slot="run-error-message"
        className="m-0 font-(family-name:--family-mono) text-assist leading-(--lead-body) font-regular whitespace-pre-wrap text-fg [overflow-wrap:anywhere]"
      >
        {message}
        {trace.map((t) => (
          <span key={t} data-slot="run-error-trace" className="block text-fg3">
            {`    ${t}`}
          </span>
        ))}
      </pre>
      {children}
      {(note != null || actions != null) && (
        <div data-slot="run-error-foot" className="flex items-center gap-(--space-4)">
          {note != null && <p className="m-0 text-assist leading-(--lead-list) text-fg2">{note}</p>}
          {actions != null && (
            <span className="ml-auto flex shrink-0 items-center gap-(--space-2)">{actions}</span>
          )}
        </div>
      )}
    </section>
  );
}

export { Log, type LogCopy, type LogLine, type LogProps, RunError, type RunErrorProps };
