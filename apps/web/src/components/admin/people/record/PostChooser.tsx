import { useRef, useState } from 'react';

import { AlertDialogError } from '@/components/kit/alert-dialog';
import { Button } from '@/components/kit/button';
import { CheckboxRow } from '@/components/kit/checkbox';
import { Kbd } from '@/components/kit/kbd';
import { Note } from '@/components/kit/note';
import { RetryNote } from '@/components/kit/retry-note';
import { Section } from '@/components/kit/section-slug';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/kit/sheet';
import { SkeletonText } from '@/components/kit/skeleton';

import { type Loadable, readState } from '../../reads/consoleReads';
import { type ChoicesRead, chooserMembers } from './recordModel';
import type { ActOutcome } from '../person/useActing';
import { RECORD_WORDS as W } from './recordWords';

/**
 * **Restore the post** (8.9 *A post*): a narrow sheet over the record, opened from a hidden Post's
 * Restore when each of its Reports went down on its own. Its members as the restore's own plan read
 * them (`moderation.postRestoreChoices`) — what each is, why it is down — **nothing chosen** until
 * the moderator chooses; a Report its author deleted is shown, never choosable. The restore is one
 * write (`setModerationStatus` with `withReportIds`); while it is out the sheet holds (Esc and Cancel
 * wait). A refusal is a toast naming the person (D268); the sheet stays open with the choices kept,
 * and a press that waited behind another change says the sheet's own note over them.
 */
export type PostChooserProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  choices: Loadable<ChoicesRead | null>;
  now: number;
  timeZone?: string;
  /** The restore with the chosen Reports; resolves what it came to (the sheet closes once it landed). */
  onRestore: (withReportIds: string[]) => Promise<ActOutcome>;
  container?: HTMLElement | null;
};

export function PostChooser({ open, onOpenChange, container, ...rest }: PostChooserProps) {
  const busy = useRef(false);
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && busy.current) return;
        onOpenChange(next);
      }}
    >
      <SheetContent size="sm" data-slot="post-chooser" {...(container != null && { container })}>
        {/* The popup's subtree unmounts while closed, so each opening starts with nothing chosen. */}
        <ChooserBody
          {...rest}
          onBusy={(b) => {
            busy.current = b;
          }}
          onDone={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

function ChooserBody({
  choices,
  now,
  timeZone,
  onRestore,
  onBusy,
  onDone,
}: Omit<PostChooserProps, 'open' | 'onOpenChange' | 'container'> & {
  onBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  // The sheet's own note, never a server's words: this press waited behind another change.
  const [waited, setWaited] = useState(false);
  // The chooser's read, its four answers apart (`readState`).
  const state = readState(choices);
  const read = state.kind === 'value' ? state.value : null;
  const members = read === null ? [] : chooserMembers(read, now, timeZone);
  // What is chosen and still choosable: a member that came up, or was deleted, since it was ticked
  // (the read is live) is neither counted nor sent.
  const picked = chosen.filter((id) => members.some((m) => m.reportId === id && m.choosable));
  // Live, every render: the server's current answer decides whether this choice — the empty one
  // included, once a plain restore brings a report back — can restore the post.
  const ready = read?.restorable === true && (picked.length > 0 || read.plainRestoreBringsBack);

  const confirm = () => {
    if (busy || !ready) return;
    setBusy(true);
    onBusy(true);
    setWaited(false);
    void onRestore(picked).then((outcome) => {
      setBusy(false);
      onBusy(false);
      if (outcome === 'landed') onDone();
      else if (outcome === 'waiting') setWaited(true);
    });
  };

  return (
    <>
      <SheetHeader closeLabel={W.close}>
        <SheetTitle>{W.chooserTitle}</SheetTitle>
      </SheetHeader>
      <SheetBody
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            confirm();
          }
        }}
      >
        {state.kind === 'loading' ? (
          <div aria-busy="true" className="flex flex-col gap-(--space-3)">
            <SkeletonText className="text-row" width="90%" />
            <SkeletonText className="text-row" width="70%" />
          </div>
        ) : state.kind === 'failed' ? (
          <RetryNote onRetry={state.failure.retry} pending={state.failure.pending}>
            {W.chooserFailed}
          </RetryNote>
        ) : state.kind === 'none' ? (
          <Note>{W.noSuchItem}</Note>
        ) : (
          <>
            {state.value.prompt !== null && (
              <p data-slot="chooser-lead" className="m-0 text-row leading-body text-fg2">
                {state.value.prompt}
              </p>
            )}
            {waited && <AlertDialogError>{W.anotherOnItsWay}</AlertDialogError>}
            <Section title={W.itsReports} count={members.length} level={3}>
              <div className="flex flex-col">
                {members.map((m) => (
                  <CheckboxRow
                    key={m.reportId}
                    data-slot="chooser-member"
                    data-choosable={m.choosable ? '' : undefined}
                    className="border-0 border-b-(length:--stroke-hair) border-dotted border-line py-(--space-2_5) last:border-b-0"
                    disabled={!m.choosable || busy}
                    checked={picked.includes(m.reportId)}
                    onCheckedChange={(on) =>
                      setChosen((c) =>
                        on ? [...c, m.reportId] : c.filter((id) => id !== m.reportId),
                      )
                    }
                    label={
                      <span className="flex flex-col gap-(--space-1)">
                        <span className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
                          {W.report}
                        </span>
                        <span>{m.title}</span>
                      </span>
                    }
                    description={
                      m.sub.quote === undefined ? (
                        m.sub.text
                      ) : (
                        <>
                          {m.sub.text}
                          <span className="text-fg1">“{m.sub.quote}”</span>
                        </>
                      )
                    }
                  />
                ))}
              </div>
            </Section>
          </>
        )}
      </SheetBody>
      <SheetFooter>
        <span className="ms-auto flex items-center gap-(--space-2_5)">
          <Button size="sm" data-slot="chooser-cancel" disabled={busy} onClick={() => onDone()}>
            {W.cancel}
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-slot="chooser-restore"
            disabled={!ready}
            loading={busy}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onClick={confirm}
          >
            {/* The board's "Restore with 0 reports" while a choice is needed; a plain Restore once
                none is. */}
            {picked.length === 0 && read?.plainRestoreBringsBack === true
              ? W.lever.restore
              : W.restoreWith(picked.length)}
            <Kbd variant="dim" aria-hidden="true">
              ⌘⏎
            </Kbd>
          </Button>
        </span>
      </SheetFooter>
    </>
  );
}
