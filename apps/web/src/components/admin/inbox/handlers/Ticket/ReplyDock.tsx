import { type ComponentProps, type ReactNode, useId, useRef } from 'react';

import { keyCap } from '@/components/kit/app-shell';
import { Button } from '@/components/kit/button';
import { Kbd } from '@/components/kit/kbd';
import { Textarea } from '@/components/kit/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { usePaneKeys } from '@/lib/keys';
import { cn } from '@/lib/utils';

/**
 * **A reply docked under a thread, like a mail client's** (board 2.8's `.compose`) — a kit
 * candidate, built beside the ticket handler: the mode picker (*Reply by email* / *Note*) with who it
 * reaches at the row's end, the boxed field, and a foot with what the mode does and its send button.
 *
 * - **⌘⏎ sends** (Ctrl ⏎ off a Mac), bound to the dock itself (`lib/keys`' `usePaneKeys` on this
 *   element): it acts only while focus is inside the dock — in the field, on the picker or the
 *   button — never from a dialog or another field, and is inert while there is nothing to send, too
 *   much, or a send is out. The button shows the same key.
 * - **Each mode has its cap** (`max`, the server's, from core): the field takes it as `maxLength`.
 *   Words carried over from a mode with a larger cap are not cut: the form's own check says so in
 *   place (D268 — it never reached the server) and the send waits.
 * - **The words are the caller's** (`value`): the dock never clears them itself, so a refused send
 *   keeps what was typed. While a send is out the field is read-only, so nothing typed then is lost
 *   to the clear that follows a landed send.
 * - With one mode the picker isn't drawn; with none, nor is the dock (the caller's rule).
 */

type ReplyDockMode<M extends string> = {
  id: M;
  /** The picker's word ("Reply by email"). */
  label: string;
  /** The row's end: who it reaches ("To Rob Tremblay"). */
  to: ReactNode;
  /** The field's accessible name ("Your reply"). */
  field: string;
  /** The foot: what this mode does, where it goes from. */
  foot: ReactNode;
  /** The send button's word ("Send reply"). */
  send: string;
  /** The server's cap for this mode. */
  max: number;
  /** The form's own check past the cap: what it says, given the words' length. */
  tooLong: (length: number) => string;
};

type ReplyDockProps<M extends string> = Omit<ComponentProps<'section'>, 'onSubmit'> & {
  modes: readonly ReplyDockMode<M>[];
  mode: M;
  onModeChange: (mode: M) => void;
  /** The picker's accessible name. */
  modesLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Sends the trimmed words; the caller clears them once it landed. */
  onSend: (text: string) => void;
  /** A send is out. */
  sending: boolean;
};

function ReplyDock<M extends string>({
  modes,
  mode,
  onModeChange,
  modesLabel,
  value,
  onValueChange,
  onSend,
  sending,
  className,
  ...props
}: ReplyDockProps<M>) {
  const dock = useRef<HTMLElement | null>(null);
  const checkId = useId();
  const current = modes.find((m) => m.id === mode) ?? modes[0];
  const text = value.trim();
  const over = current !== undefined && text.length > current.max;
  const ready = current !== undefined && text !== '' && !over && !sending;
  const send = () => {
    if (ready) onSend(text);
  };
  usePaneKeys(dock, [{ key: 'Mod+Enter', run: send, enabled: ready, label: current?.send }]);
  if (current === undefined) return null;
  return (
    <section
      ref={dock}
      data-slot="reply-dock"
      data-mode={current.id}
      aria-label={current.label}
      className={cn(
        'flex min-w-0 flex-col gap-(--space-2) border-0 border-t border-solid border-line',
        'px-gutter pt-(--space-3_5) pb-(--space-4)',
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-(--space-3) gap-y-(--space-1_5)">
        {modes.length > 1 && (
          <ToggleGroup
            aria-label={modesLabel}
            value={current.id}
            onValueChange={(next) => onModeChange(next as M)}
          >
            {modes.map((m) => (
              <ToggleGroupItem key={m.id} value={m.id} data-mode={m.id}>
                {m.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <span
          data-slot="reply-dock-to"
          className="ms-auto font-(family-name:--family-mono) text-kick leading-none tracking-micro text-fg3 uppercase"
        >
          {current.to}
        </span>
      </div>
      <Textarea
        data-slot="reply-dock-field"
        aria-label={current.field}
        aria-describedby={over ? checkId : undefined}
        aria-invalid={over || undefined}
        value={value}
        onValueChange={(next) => onValueChange(String(next))}
        maxLength={current.max}
        readOnly={sending}
        rows={4}
        className="min-h-[5.75rem]"
      />
      {over && (
        <span
          id={checkId}
          data-slot="reply-dock-check"
          className="text-assist leading-list text-bad"
        >
          {current.tooLong(text.length)}
        </span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-(--space-3) gap-y-(--space-2)">
        <span
          data-slot="reply-dock-foot"
          className="min-w-0 flex-1 text-assist leading-list text-fg3"
        >
          {current.foot}
        </span>
        <Button
          data-slot="reply-dock-send"
          variant="outline"
          className="ms-auto"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          disabled={!ready && !sending}
          loading={sending}
          onClick={send}
        >
          {current.send}
          <Kbd variant="dim" aria-hidden="true">
            {keyCap('Mod+Enter')}
          </Kbd>
        </Button>
      </div>
    </section>
  );
}

export { ReplyDock, type ReplyDockMode, type ReplyDockProps };
