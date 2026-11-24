import { ONBOARDING_COPY, type ReceiptLine } from '@skating/core';
import { useState } from 'react';

import { DOC_URLS } from '@/lib/links';
import { cn } from '@/lib/utils';

import { Button } from '../../kit/button';
import { CheckboxRow } from '../../kit/checkbox';
import { ENTRY_PRIMARY, EntryHead, EntryScreen, WIDE } from './EntryScreen';
import { TermsReader, type TermsReaderVia } from './TermsReader';

/**
 * The agreement (boards 10.3, 10.4): *"I have read and agree to the Terms of Use and the Privacy
 * Notice."* — core's words, the notice the one link. **Locked** (the box off, the words faint) until
 * the end of the terms has been on screen; the link works either way, because the notice is read,
 * never scroll-gated (D295). Opening the link never ticks the box: a press on a link inside a label
 * doesn't activate the label's control. On a desk it sits on a panel; on a phone, bare, in the foot.
 */
export function AgreeLine({
  locked,
  checked,
  onCheckedChange,
}: {
  locked: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const agree = ONBOARDING_COPY.terms.agree;
  return (
    <div
      data-slot="agree-line"
      data-locked={locked ? '' : undefined}
      className="border border-line border-solid bg-panel p-4 @max-[48rem]/entry:border-0 @max-[48rem]/entry:bg-transparent @max-[48rem]/entry:p-0"
    >
      <CheckboxRow
        checked={checked && !locked}
        disabled={locked}
        onCheckedChange={(next) => onCheckedChange(next)}
        className={cn(
          'gap-x-3 text-[0.84375rem] leading-[1.55] has-data-checked:text-fg1',
          locked ? 'text-fg3' : 'text-fg1',
        )}
        label={
          <span>
            {agree.before}
            <a
              href={DOC_URLS.privacy}
              target="_blank"
              rel="noreferrer"
              className="text-fg underline underline-offset-[3px] [label[data-disabled]_&]:cursor-pointer"
              data-attr="terms-privacy-notice"
            >
              {agree.link}
            </a>
            {agree.after}
          </span>
        }
      />
    </div>
  );
}

/**
 * **Read the terms** (boards 10.3, 10.4, 11.2–11.4): the reader, the agreement, *Record
 * acceptance*. Props only: whether the end has been reached (`read`) and whether reaching it counts
 * now (`armed`) are the page's, which records them; the box is this screen's until it is sent.
 */
export function TermsStep({
  step,
  read,
  armed,
  disarmed = false,
  onEndGone,
  busy,
  resetKey,
  email,
  onEnd,
  onScrollActivity,
  onRecord,
  onSignOut,
  initialChecked = false,
  className,
}: {
  /** "2 of 5" for an account new this session, else `null`. */
  step: number | null;
  read: boolean;
  armed: boolean;
  /** A failed stamp: the end counts again only once the marker has left the screen (`onEndGone`). */
  disarmed?: boolean;
  onEndGone?: () => void;
  /** *Record acceptance* is on its way. */
  busy: boolean;
  resetKey?: number;
  email: string | null;
  onEnd: (via: TermsReaderVia) => void;
  /** The skater scrolled a reader (a failed opening is tried again on it). */
  onScrollActivity?: () => void;
  onRecord: () => void;
  onSignOut: () => void;
  /** A board's ticked box. */
  initialChecked?: boolean;
  className?: string;
}) {
  const copy = ONBOARDING_COPY.terms;
  const [checked, setChecked] = useState(initialChecked);
  const [progress, setProgress] = useState(0);
  // A reading reset or re-locked clears the box, as on the phone: a tick given to one reading of the
  // terms is never carried to the next, and the box can't re-tick itself when it unlocks again.
  const [reading, setReading] = useState({ read, resetKey });
  if (reading.read !== read || reading.resetKey !== resetKey) {
    setReading({ read, resetKey });
    if (!read || reading.resetKey !== resetKey) setChecked(false);
  }
  const ready = read && checked;
  return (
    <EntryScreen
      width="terms"
      className={className}
      email={email}
      onSignOut={onSignOut}
      progress={read ? 1 : progress}
      head={
        <EntryHead kicker={copy.kicker} step={step} title={copy.heading}>
          {copy.lede}
        </EntryHead>
      }
      actions={
        <>
          <AgreeLine locked={!read} checked={checked} onCheckedChange={setChecked} />
          <Button
            variant="primary"
            disabled={!ready}
            loading={busy}
            className={cn(ENTRY_PRIMARY, WIDE, 'mt-2 @max-[48rem]/entry:mt-0')}
            onClick={() => ready && !busy && onRecord()}
            data-attr="terms-record-acceptance"
          >
            {copy.submit}
          </Button>
        </>
      }
    >
      <TermsReader
        read={read}
        armed={armed}
        disarmed={disarmed}
        onEndGone={onEndGone}
        resetKey={resetKey}
        onEnd={onEnd}
        onScrollActivity={onScrollActivity}
        onProgress={setProgress}
      />
    </EntryScreen>
  );
}

/**
 * **Acceptance recorded** (boards 10.5, 11.5): the receipt, under the hold. No times — the stamps
 * are evidence, not interface (D295). The sent-to line names the address the copy went to
 * (`ph-no-capture`: it is an email address); it says the copy didn't go only when that is known.
 * Then the *Next: Know Before You Go* block when the questions are due, and *Start the questions*;
 * with none due there is no block, and the button is *Continue* (a draft, not drawn).
 */
export function ReceiptStep({
  step,
  line,
  questionsDue,
  email,
  onContinue,
  onSignOut,
  className,
}: {
  step: number | null;
  /** The receipt's line, or `null` while there is nothing to say yet. */
  line: ReceiptLine | null;
  questionsDue: boolean;
  email: string | null;
  onContinue: () => void;
  onSignOut: () => void;
  className?: string;
}) {
  const copy = ONBOARDING_COPY.receipt;
  const next = ONBOARDING_COPY.next;
  return (
    <EntryScreen
      width="receipt"
      className={className}
      email={email}
      onSignOut={onSignOut}
      head={
        <EntryHead kicker={copy.kicker} step={step} title={copy.heading}>
          {line === null ? null : line.kind === 'sent' ? (
            <p data-slot="receipt-line" className="ph-no-capture m-0">
              {line.before}
              <b>{line.email}</b>
              {line.after}
            </p>
          ) : (
            <p data-slot="receipt-line" className="m-0">
              {line.text}
            </p>
          )}
        </EntryHead>
      }
      actions={
        <Button
          variant="primary"
          autoFocus
          className={cn(ENTRY_PRIMARY, WIDE)}
          onClick={onContinue}
          data-attr={questionsDue ? 'receipt-start-questions' : 'receipt-continue'}
        >
          {questionsDue ? copy.start : copy.continue}
        </Button>
      }
    >
      {questionsDue && (
        <div
          data-slot="receipt-next"
          className="flex flex-col gap-3.5 border-0 border-line border-t border-solid pt-[1.375rem]"
        >
          <span className="font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
            {next.kicker}
          </span>
          <p className="m-0 text-[0.90625rem] text-fg1 leading-normal">{next.body}</p>
          <ol className="m-0 flex list-none flex-col p-0">
            {next.how.map((how, i) => (
              <li
                key={how}
                className="flex items-baseline gap-3.5 border-0 border-line2 border-b border-dotted py-2.5 text-[0.90625rem] text-fg leading-[1.4] last:border-b-0 last:pb-0"
              >
                <span
                  aria-hidden="true"
                  className="w-2.5 flex-none font-(family-name:--family-mono) font-medium text-fg3 text-kick"
                >
                  {i + 1}
                </span>
                {how}
              </li>
            ))}
          </ol>
        </div>
      )}
    </EntryScreen>
  );
}
