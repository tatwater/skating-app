/**
 * **Does another tab hold report work not yet sent?** — asked at Sign out, answered by the tabs.
 *
 * The report sheet lives in each tab's memory; only a *new* report's draft reaches storage (an edit
 * of a published one never does: restored later over someone else's save, a stale copy would undo
 * it — `sheetStore`'s `persist`). So a tab signing out can't see an edit open in another tab, and
 * the sign-out ends that tab's session too (its sheet goes with the account, `bindSheetOwner`).
 *
 * So Sign out asks, at that moment, over a `BroadcastChannel`: every tab that holds unsent work
 * answers at once; silence for {@link UNSAVED_ASK_MS} is "nothing". Nothing is stored, so nothing
 * can go stale; the ask and the answer carry an id and a word, never what was written. A browser
 * without the channel answers `unknown`, which the guard treats as a warning, never as silence.
 */

import type { PostDraft, PostSheet } from '@skating/core';

/**
 * **What a sign-out would lose**, the one rule for this tab and every other: a sheet the author has
 * written in (`dirty` — a new report or an edit of a published one), or one whose send failed and
 * waits for a retry or a resend (`attempt`, photos mid-upload among its checkpoints). A sheet
 * opened and left untouched loses nothing worth asking about.
 */
export function holdsUnsentWork(sheet: PostSheet | null, attempt: PostDraft | null): boolean {
  return sheet !== null && (sheet.dirty || attempt !== null);
}

/** How long Sign out waits for another tab to say it holds work. */
export const UNSAVED_ASK_MS = 300;

const CHANNEL = 'gli-unsaved-sheet';

/** The slice of `BroadcastChannel` this needs — the test seam. */
export interface UnsavedChannel {
  post: (message: unknown) => void;
  listen: (heard: (message: unknown) => void) => () => void;
  close: () => void;
}

type Message = { type: 'ask' | 'held'; ask: string };

function browserChannel(): UnsavedChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    // A browser can refuse the channel (where this site's storage is blocked): it can't ask its
    // tabs, so it answers `unknown` — and the tab answering, mounted under every page, never throws.
    return null;
  }
  return {
    post: (m) => channel.postMessage(m),
    listen: (heard) => {
      const on = (e: MessageEvent) => heard(e.data);
      channel.addEventListener('message', on);
      return () => channel.removeEventListener('message', on);
    },
    close: () => channel.close(),
  };
}

let open: () => UnsavedChannel | null = browserChannel;
let waitMs = UNSAVED_ASK_MS;

/**
 * Test seam: the tabs' channel and the wait (`undefined` puts the browser's channel and the real
 * wait back). A component test passes a short wait so a Sign out settles inside its own test.
 */
export function setUnsavedChannelForTests(
  make: (() => UnsavedChannel | null) | undefined,
  wait: number = UNSAVED_ASK_MS,
): void {
  open = make ?? browserChannel;
  waitMs = wait;
}

/** A browser with no other tab open: every ask is answered `none` once the wait is up. */
export const NO_OTHER_TABS = (): UnsavedChannel => ({
  post: () => {},
  listen: () => () => {},
  close: () => {},
});

function isMessage(m: unknown): m is Message {
  if (typeof m !== 'object' || m === null) return false;
  const { type, ask } = m as Record<string, unknown>;
  return (type === 'ask' || type === 'held') && typeof ask === 'string';
}

/** This tab, for the life of the page: an ask never hears its own tab. */
export const THIS_TAB = Math.random().toString(36).slice(2);

/**
 * Answer other tabs' asks while mounted: `held` when `holds()` says this tab has unsent work.
 * Returns the stop.
 */
export function answerUnsavedAsks(holds: () => boolean, tab: string = THIS_TAB): () => void {
  const channel = open();
  if (channel === null) return () => {};
  const stop = channel.listen((m) => {
    if (!isMessage(m) || m.type !== 'ask' || m.ask.startsWith(`${tab}:`)) return;
    if (holds()) channel.post({ type: 'held', ask: m.ask } satisfies Message);
  });
  return () => {
    stop();
    channel.close();
  };
}

/** Ask the other tabs: `held` as soon as one answers, `none` after the wait, `unknown` if it can't. */
export function askOtherTabs(tab: string = THIS_TAB): Promise<'held' | 'none' | 'unknown'> {
  const channel = open();
  if (channel === null) return Promise.resolve('unknown');
  const ask = `${tab}:${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (answer: 'held' | 'none' | 'unknown') => {
      clearTimeout(timer);
      stop();
      channel.close();
      resolve(answer);
    };
    const stop = channel.listen((m) => {
      if (isMessage(m) && m.type === 'held' && m.ask === ask) done('held');
    });
    timer = setTimeout(() => done('none'), waitMs);
    try {
      channel.post({ type: 'ask', ask } satisfies Message);
    } catch {
      // The ask never went out: no tab heard it, so silence would mean nothing.
      done('unknown');
    }
  });
}
