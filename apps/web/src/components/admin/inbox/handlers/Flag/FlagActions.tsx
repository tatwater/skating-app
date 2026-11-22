import { AUDIT_REASON_MAX } from '@skating/core';
import { type ReactNode, type RefObject, useState } from 'react';

import { ActionBar, type ActionBarGroup, type ActionBarItem } from '@/components/kit/action-bar';

import { AskDialog } from '../../../people/person/AskDialog';
import { allows, type FlagVerb, targetNoun, verbGroups } from './flagModel';
import type { FlagItem } from './flagTypes';
import { FLAG_WORDS as W } from './flagWords';
import {
  LIVE_WORDING,
  PHOTO_WORDS as P,
  REMOVAL_WORDINGS,
  type RemovalWording,
} from './photoWords';
import type { FlagWrite } from './useFlagWrites';

/**
 * **The flag handler's bar** (2.1: *Flag* Dismiss · *Report* Hide, Remove · *Author*; 2.6: *Alert*
 * Unpin, Retract · *Flag* Dismiss): the kit `ActionBar` at the inspector's foot, each button's key
 * its letter, acting only while the inspector pane has focus. A button is drawn only when the item's
 * `can` says `null` for its verb — a sentence is the server's refusal, and the button is not drawn
 * (D217); with nothing to draw there is no bar at all (the viewer's own content, D269, included).
 *
 * - **A reason when something is taken away** (D226): Hide, Remove, Unpin and Retract ask it in the
 *   console's reason dialog (People's `AskDialog`, by import); Dismiss offers one but asks none;
 *   Restore gives back and acts on one press.
 * - **Which flags a lever closes** is in its dialog's words: Hide and Remove close every open flag
 *   on the content in every lane; Dismiss clears only this item's (the founder's rule).
 * - The dialog sends with ⌘⏎, leaves with Esc, and stays open over what was typed when its write is
 *   refused (the refusal is a toast, D268).
 */

export type FlagActionsProps = {
  item: Pick<FlagItem, 'can' | 'target' | 'flags'>;
  /** Runs a write; resolves whether it landed. */
  onWrite: (write: FlagWrite) => Promise<boolean>;
  /** The inspector pane the keys act in. */
  pane?: RefObject<HTMLElement | null>;
  /** The author menu, as a control in the bar (`inspector/AuthorMenu`). */
  author?: ReactNode;
  /**
   * A photo's takedown words: whether its bytes move at takedown (`moved`) or not (`kept`). The live
   * console passes none and says {@link LIVE_WORDING}'s; the stories draw both.
   */
  wording?: RemovalWording;
};

type Asking = Exclude<FlagVerb, 'restore'>;

const LABEL: Record<FlagVerb, string> = {
  dismiss: W.dismiss,
  hide: W.hide,
  remove: W.remove,
  restore: W.restore,
  pin: W.pin,
  unpin: W.unpin,
  retract: W.retract,
};

export function FlagActions({
  item,
  onWrite,
  pane,
  author,
  wording = LIVE_WORDING,
}: FlagActionsProps) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [open, setOpen] = useState(false);
  const [serial, setSerial] = useState(0);
  const [busy, setBusy] = useState<FlagVerb | null>(null);
  const groups = verbGroups(item);
  if (groups.length === 0) return null;

  const run = async (verb: FlagVerb, write: FlagWrite): Promise<boolean> => {
    setBusy(verb);
    try {
      return await onWrite(write);
    } catch {
      // The write path says every refusal itself; a throw past it changed nothing.
      return false;
    } finally {
      setBusy(null);
    }
  };

  const press = (verb: FlagVerb) => {
    if (busy !== null) return;
    if (verb === 'restore') {
      void run(verb, { kind: 'restore' });
      return;
    }
    setAsking(verb);
    setSerial((s) => s + 1);
    setOpen(true);
  };
  const photo = item.target.exists && item.target.targetType === 'photo';
  const what = (verb: FlagVerb): string =>
    !photo
      ? W.what[verb]
      : verb === 'hide'
        ? REMOVAL_WORDINGS[wording].hideWhat
        : verb === 'remove'
          ? P.what.remove
          : verb === 'restore'
            ? P.what.restore
            : W.what[verb];

  const barGroups: ActionBarGroup[] = groups.map((g) => ({
    id: g.id,
    label: g.label,
    items: g.verbs.map(
      (verb): ActionBarItem => ({
        id: verb,
        label: LABEL[verb],
        what: what(verb),
        onPress: () => press(verb),
        danger: verb === 'remove' || verb === 'retract',
        loading: busy === verb,
      }),
    ),
  }));
  if (author != null) {
    barGroups.push({
      id: 'author',
      label: W.groupAuthor,
      items: [{ kind: 'control', id: 'author', control: author }],
    });
  }

  const noun = item.target.exists ? targetNoun(item.target) : '';
  const withdrawn = item.target.exists && item.target.withdrawnAt !== null;
  const words =
    asking === null
      ? null
      : photo && (asking === 'hide' || asking === 'remove')
        ? photoDialogWords(asking, wording, withdrawn)
        : dialogWords(
            asking,
            noun,
            item.flags.filter((f) => f.status === 'open').length,
            withdrawn,
          );
  // A hide whose bytes stay on their address points to Remove for an urgent case, when Remove is
  // drawn. Words, not a button: a button above the reason would take the dialog's opening focus.
  const urgent =
    photo && asking === 'hide' && allows(item.can, 'remove')
      ? REMOVAL_WORDINGS[wording].urgent
      : null;

  return (
    <>
      <ActionBar
        data-slot="flag-actions"
        aria-label={W.bar}
        groups={barGroups}
        {...(pane !== undefined && { pane })}
      />
      {asking !== null && words !== null && (
        <AskDialog
          key={serial}
          open={open}
          onOpenChange={setOpen}
          title={words.title}
          description={words.body}
          confirm={LABEL[asking]}
          reason={asking === 'dismiss' ? 'optional' : true}
          reasonLabel={asking === 'dismiss' ? W.reasonOptional : W.reasonLabel}
          // The server's cap on an audit reason: an over-long one is stopped here, not refused.
          maxLength={AUDIT_REASON_MAX}
          destructive={asking === 'remove' || asking === 'retract'}
          {...(urgent !== null && {
            children: (
              <p data-slot="photo-urgent" className="m-0 text-assist leading-list text-fg2">
                {urgent}
              </p>
            ),
          })}
          onConfirm={async (reason) => {
            const landed = await run(asking, writeOf(asking, reason));
            return landed ? 'landed' : 'refused';
          }}
        />
      )}
    </>
  );
}

/** The write a verb's dialog sends, with what was typed. */
export function writeOf(verb: Asking, reason: string): FlagWrite {
  switch (verb) {
    case 'dismiss':
      return reason.trim() === '' ? { kind: 'dismiss' } : { kind: 'dismiss', reason };
    case 'hide':
      return { kind: 'takeDown', status: 'hidden', reason };
    case 'remove':
      return { kind: 'takeDown', status: 'removed', reason };
    case 'pin':
      return { kind: 'alert', verb: 'pin', reason };
    case 'unpin':
      return { kind: 'alert', verb: 'unpin', reason };
    case 'retract':
      return { kind: 'alert', verb: 'retract', reason };
  }
}

/**
 * A photo takedown's title and words, in the proof's wording: what skaters stop seeing, whether a link
 * someone already has still opens it, a removal's 30 days, and the flags it closes.
 */
export function photoDialogWords(
  verb: 'hide' | 'remove',
  wording: RemovalWording,
  /** Its uploader withdrew it: the decision is kept on their record; nothing comes back. */
  withdrawn = false,
): { title: string; body: string } {
  const w = REMOVAL_WORDINGS[wording];
  const title = verb === 'hide' ? P.hideTitle : P.removeTitle;
  if (withdrawn) return { title, body: W.withdrawnTakeDownBody };
  return { title, body: `${verb === 'hide' ? w.hideBody : w.removeBody} ${P.closesFlags}` };
}

/** A dialog's title and words: what the lever does, and which flags it closes. */
export function dialogWords(
  verb: Asking,
  noun: string,
  flags: number,
  /** Its author withdrew it: a takedown keeps a decision on the record and brings nothing back. */
  withdrawn = false,
): { title: string; body: string } {
  const takeDown = withdrawn ? W.withdrawnTakeDownBody : W.takeDownBody;
  switch (verb) {
    case 'dismiss':
      return { title: W.dismissTitle, body: W.dismissBody(flags) };
    case 'hide':
      return { title: W.hideTitle(noun), body: takeDown };
    case 'remove':
      return { title: W.removeTitle(noun), body: takeDown };
    case 'pin':
      return { title: W.pinTitle, body: W.pinBody };
    case 'unpin':
      return { title: W.unpinTitle, body: W.unpinBody };
    case 'retract':
      return { title: W.retractTitle, body: W.retractBody };
  }
}
