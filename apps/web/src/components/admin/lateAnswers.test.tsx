import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConvexError } from 'convex/values';
import { type ReactNode, useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **Every server refusal is one toast, wherever the operator is when it comes** (D268, the founder's
 * call of 2026-11-16: "Always a toast"). One row per admin write path in the phase doc's inventory,
 * each sent from the place that asks for it, the operator then moving — staying where they were,
 * another tab, another body or person, another section of the console, the console's loading
 * splash, or out to the skater app — and the server answering with a refusal in its own words, a
 * server error, or a send that failed. In every cell the answer is the same, and that sameness is
 * the point: exactly one toast, naming its subject and what was not changed, held until dismissed;
 * nothing of the server's printed anywhere on the page; and a dialog or form that asked, if it is
 * still there, still open with what was typed. Nothing in the write paths asks where the operator is.
 *
 * Rows that share a write path (every pick-store control, say) share its harness here; the words
 * each row's real control passes are its own.
 */

const mocks = vi.hoisted(() => {
  const pending: { reject: (err: unknown) => void }[] = [];
  /** Every mutation: held until the test answers it. */
  const mutate = (_args?: unknown) =>
    new Promise<never>((_, reject) => {
      pending.push({ reject });
    });
  return {
    pending,
    mutate,
    toasts: [] as { title: string; description?: string; tone?: string; timeout?: number }[],
  };
});
vi.mock('convex/react', () => ({ useMutation: () => mocks.mutate, useQuery: () => undefined }));
vi.mock('@/components/kit/toast', async (original) => ({
  ...(await original<typeof import('@/components/kit/toast')>()),
  toast: (t: (typeof mocks.toasts)[number]) => mocks.toasts.push(t),
}));
vi.mock('@/lib/useRole', () => ({
  useRole: () => ({ canModerate: true, can: () => true, userId: 'viewer' }),
}));

import { api } from '@skating/convex/api';
import { AUDIT_REASON_MAX } from '@skating/core';
import { useMutation } from 'convex/react';
import { Button } from '@/components/kit/button';
import { ModeratorActions } from '../ModeratorActions';
import { Button as LegacyButton } from '../ui/button';
import { BodyBindingProvider, listChanged, sendFor, useBodyHold } from './body/frame/currentBody';
import { ReasonAsk } from './body/tabs/access/ReasonAsk';
import { stubJsdomAnimations } from './body/tabs/jsdomStubs';
import { useLatestPick } from './body/tabs/latestPick';
import { chipChange, ListWritersProvider, useListWriter } from './body/tabs/listWriter';
import { StandingTabView } from './body/tabs/standing/StandingTabView';
import {
  ACTIVE,
  ACTIVE_SINCE,
  BODY_NOW,
  MASCOMA_RETENTION,
} from './body/tabs/standing/standingFixtures';
import { useTabAction } from './body/tabs/useTabAction';
import { AskDialog } from './people/person/AskDialog';
import { useActing } from './people/person/useActing';
import { usePersonWrites } from './people/person/usePersonWrites';
import { SUBJECT } from './people/record/recordFixtures';
import { useRecordActing } from './people/record/useRecordActing';
import { useRecordWrites } from './people/record/useRecordWrites';
import { ReasonDialog } from './ReasonDialog';
import { useSaidMutation } from './said';
import { UndoProvider, useUndo } from './shell/undo';

beforeAll(stubJsdomAnimations);
beforeEach(() => {
  mocks.pending.length = 0;
  mocks.toasts.length = 0;
});

// ── Where the operator is when the answer comes ────────────────────────────────────────────────

const PLACES = [
  'the same place',
  'another tab',
  'another body or person',
  'another console section',
  'the console’s loading splash',
  'the skater app',
] as const;
type Place = (typeof PLACES)[number];

/** Undo's server: its run is the held mutation, as `useUndoServer`'s is Convex's. */
const undoServer = { latestOwn: async () => null, run: (args: unknown) => mocks.mutate(args) };

/**
 * The app as each place draws it. The queues' owners (the list writers, the pick store, Undo) sit
 * above the console's splash, as `ConsoleLayout` mounts them; leaving for the skater app takes the
 * whole console with it. A body's subtree is keyed by its body, as the frame keys it.
 */
function App({ place, children }: { place: Place; children: ReactNode }) {
  if (place === 'the skater app') return <main>The skater map</main>;
  const body = place === 'another body or person' ? 'wb2' : 'wb1';
  return (
    <ListWritersProvider>
      <UndoProvider server={undoServer}>
        {place === 'the console’s loading splash' ? (
          <p>Loading the console…</p>
        ) : place === 'another console section' ? (
          <p>People</p>
        ) : (
          <BodyBindingProvider
            key={body}
            bodyId={body}
            name={body === 'wb1' ? 'Mascoma Lake' : 'Crystal Lake'}
          >
            {place === 'the same place' ? children : <p>Another tab</p>}
          </BodyBindingProvider>
        )}
      </UndoProvider>
    </ListWritersProvider>
  );
}

// ── The answers ───────────────────────────────────────────────────────────────────────────────

const ANSWERS = [
  [
    'refused, in the server’s words',
    () => new ConvexError('Not allowed for this one'),
    'Not allowed for this one',
  ],
  ['a server error', () => new ConvexError({ code: 'internal' }), 'That write was rejected.'],
  [
    'a send that failed',
    () => new TypeError('Failed to fetch'),
    'Something went wrong — check your connection and try again.',
  ],
] as const;

// ── The write paths, as their controls send them ──────────────────────────────────────────────

const target = { targetType: 'waterbody' as const, targetId: 'wb1' };

/** A button's write through the tabs' runner (`act`, on `sendFor`). */
function Act({ what }: { what: string }) {
  const { act } = useTabAction('wb1');
  const mutate = useMutation(api.waterBodies.setWaterBodyName);
  return (
    <Button onClick={() => void act(() => mutate({} as never), { title: what, target })}>
      Send
    </Button>
  );
}

/** A press-to-save control (`useLatestPick`): the latest press wins, through `attempt`. */
function Pick({ what, keyName }: { what: string; keyName: string }) {
  const { attempt, words } = useTabAction('wb1');
  const mutate = useMutation(api.waterBodies.setClass);
  const pick = useLatestPick<string>(`${keyName}:wb1`, 'auto', {
    send: () => attempt(() => mutate({} as never), { title: 'Saved', target }, what),
    words: words(what),
  });
  return (
    <Button aria-pressed={pick.shown === 'never'} onClick={() => void pick.press('never')}>
      Send
    </Button>
  );
}

/** A whole-list write through its queue (`useListWriter`, on `sendFor`). */
function List({ what, keyName }: { what: string; keyName: string }) {
  const hold = useBodyHold();
  const mutate = useMutation(api.waterBodies.setAliases);
  const push = useListWriter<string>(`${keyName}:wb1`, ['The Basin'], async (next, base) => {
    try {
      return await sendFor(hold, {
        body: 'wb1',
        write: () => mutate({ aliases: [...next], expected: [...base] } as never),
        receipt: async () => {},
        what,
      });
    } catch (err) {
      const current = listChanged(err);
      if (current !== null) return { current: current as string[] };
      throw err;
    }
  });
  return (
    <Button onClick={() => void push(chipChange(['The Basin'], ['The Basin', 'Big Pond']))}>
      Send
    </Button>
  );
}

/** A Body console reason dialog (`ReasonAsk`) whose confirm runs the tabs' `act`. */
function AskThenAct({ what }: { what: string }) {
  const { act } = useTabAction('wb1');
  const mutate = useMutation(api.putIns.hide);
  return (
    <ReasonAsk
      trigger={<Button>Open</Button>}
      title="Why?"
      confirm="Send"
      maxLength={AUDIT_REASON_MAX}
      onConfirm={() => act(() => mutate({} as never), { title: what, target })}
    />
  );
}

/** Ruling no public access: a reason dialog whose confirm is a press on the pick store. */
function AskThenPick({ what }: { what: string }) {
  const { attempt, words } = useTabAction('wb1');
  const mutate = useMutation(api.waterBodies.setPublicAccess);
  const rule = useLatestPick<string | null, string>('access-ruling:wb1', null, {
    send: () => attempt(() => mutate({} as never), { title: 'Ruled', target }, what),
    words: words(what),
  });
  return (
    <ReasonAsk
      trigger={<Button>Open</Button>}
      title="Why?"
      confirm="Send"
      maxLength={AUDIT_REASON_MAX}
      onConfirm={async (reason) => (await rule.press('none', reason))?.landed ?? true}
    />
  );
}

/** Standing's form: its note typed, then sent through `sendFor`. */
function StandingForm() {
  const hold = useBodyHold();
  const mutate = useMutation(api.standing.setStanding);
  const write = () =>
    sendFor(hold, {
      body: 'wb1',
      write: () => mutate({} as never),
      receipt: async () => {},
      what: 'Set dormant',
    });
  return (
    <StandingTabView
      standing={ACTIVE}
      activeSince={ACTIVE_SINCE}
      retention={MASCOMA_RETENTION}
      now={BODY_NOW}
      canSetStanding
      canRemove
      onSetDormant={write}
      onSetActive={write}
      onRemove={write}
      onRestore={write}
    />
  );
}

const ROB = { userId: 'rob'.padEnd(32, '0'), displayName: 'Rob Tremblay', defaultBountyLimit: 3 };

/** A person page's lever pressed at once (`useActing` over `usePersonWrites`). */
function Lever() {
  const acting = useActing(usePersonWrites(ROB, BODY_NOW));
  return (
    <Button
      onClick={() => void acting.act('lift', { kind: 'lift' }, { region: null, inline: true })}
    >
      Send
    </Button>
  );
}

/** A person page's lever behind its reason dialog (`AskDialog`). */
function LeverDialog() {
  const acting = useActing(usePersonWrites(ROB, BODY_NOW));
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <AskDialog
        open={open}
        onOpenChange={setOpen}
        title="Ban?"
        description="Why?"
        confirm="Send"
        reason
        onConfirm={(reason) =>
          acting.act('ban', { kind: 'ban', reason }, { region: null, inline: false })
        }
      />
    </>
  );
}

/** The record sheet's Hide again, behind its reason dialog (`useRecordWrites`). */
function RecordDialog() {
  const { announce } = useUndo();
  const mutate = useMutation(api.moderation.setModerationStatus);
  const onAct = useRecordWrites({
    server: { setStatus: mutate as never, overturn: mutate as never, keep: mutate as never },
    announce,
    subject: SUBJECT,
    placeOf: () => null,
    onRestored: () => {},
    now: BODY_NOW,
  });
  const item = { targetType: 'report' as const, targetId: 'r1' };
  const acting = useRecordActing({ current: item, present: true, onAct });
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <AskDialog
        open={open}
        onOpenChange={setOpen}
        title="Hide again?"
        description="Why?"
        confirm="Send"
        reason
        onConfirm={(reason) =>
          acting.run(item, { kind: 'hideAgain', reason }, { region: null, inline: false })
        }
      />
    </>
  );
}

/** Undo from a receipt or a History row; with a reason, through Undo's own dialog. */
function Undo({ needsReason }: { needsReason: boolean }) {
  const { undo } = useUndo();
  return (
    <Button onClick={() => undo({ actionId: 'a1', needsReason, what: 'Hid it' })}>
      {needsReason ? 'Open' : 'Send'}
    </Button>
  );
}

/** A Legacy page's write with no `catch` of its own (Support's buttons, the water list's Approve). */
function LegacyButtonWrite() {
  const assign = useSaidMutation(api.support.assign);
  return <LegacyButton onClick={() => void assign({} as never).catch(() => {})}>Send</LegacyButton>;
}

/** A Legacy reason dialog (`ReasonDialog`) over the net. */
function LegacyDialog() {
  const demote = useSaidMutation(api.bodyFeatures.demote);
  return (
    <ReasonDialog
      trigger={<LegacyButton>Open</LegacyButton>}
      title="Why?"
      confirmLabel="Send"
      onConfirm={() => demote({} as never)}
    />
  );
}

// ── The rows: the inventory ───────────────────────────────────────────────────────────────────

type Row = {
  name: string;
  draw: () => ReactNode;
  /** The toast's title, and its description from the server's words. */
  title: string;
  describe: (why: string) => string;
  /** How it is sent: a press, or a dialog (or form) filled in and confirmed. */
  send: 'press' | 'dialog' | 'form' | 'legacy dialog' | 'moderator dialog';
};

const BODY = 'Not saved · Mascoma Lake';
const body = (what: string) => (why: string) => `${what}: ${why}`;
const words = (why: string) => why;

const ROWS: Row[] = [
  {
    name: 'Names: Display this (pick store)',
    draw: () => <Pick what="The displayed name" keyName="names-name" />,
    title: BODY,
    describe: body('The displayed name'),
    send: 'press',
  },
  {
    name: 'Names: the class (pick store)',
    draw: () => <Pick what="The class" keyName="names-class" />,
    title: BODY,
    describe: body('The class'),
    send: 'press',
  },
  {
    name: 'Names: aliases (list queue)',
    draw: () => <List what="The aliases" keyName="names-aliases" />,
    title: BODY,
    describe: body('The aliases'),
    send: 'press',
  },
  {
    name: 'Names: a community name (act)',
    draw: () => <Act what="Named “The Basin”" />,
    title: BODY,
    describe: body('Named “The Basin”'),
    send: 'press',
  },
  {
    name: 'Water: a depth source (pick store)',
    draw: () => <Pick what="The mean depth’s source" keyName="water-depth-mean" />,
    title: BODY,
    describe: body('The mean depth’s source'),
    send: 'press',
  },
  {
    name: 'Access: a ruling button (pick store)',
    draw: () => <Pick what="The ruling" keyName="access-ruling-buttons" />,
    title: BODY,
    describe: body('The ruling'),
    send: 'press',
  },
  {
    name: 'Access: Rule no public access (its reason dialog, the pick store)',
    draw: () => <AskThenPick what="The ruling" />,
    title: BODY,
    describe: body('The ruling'),
    send: 'dialog',
  },
  {
    name: 'Access: Make official (act)',
    draw: () => <Act what="Made the launch official" />,
    title: BODY,
    describe: body('Made the launch official'),
    send: 'press',
  },
  {
    name: 'Access: Hide (its reason dialog)',
    draw: () => <AskThenAct what="Hid the launch" />,
    title: BODY,
    describe: body('Hid the launch'),
    send: 'dialog',
  },
  {
    name: 'Places: a landmark’s spellings (list queue)',
    draw: () => <List what="The spellings" keyName="aliases-lm1" />,
    title: BODY,
    describe: body('The spellings'),
    send: 'press',
  },
  {
    name: 'Places: Dismiss, Decline (their reason dialogs)',
    draw: () => <AskThenAct what="Declined “Long Point”" />,
    title: BODY,
    describe: body('Declined “Long Point”'),
    send: 'dialog',
  },
  {
    name: 'Places: Same place (act)',
    draw: () => <Act what="Answered with the landmark already there" />,
    title: BODY,
    describe: body('Answered with the landmark already there'),
    send: 'press',
  },
  {
    name: 'Links (list queue)',
    draw: () => <List what="The links" keyName="links" />,
    title: BODY,
    describe: body('The links'),
    send: 'press',
  },
  {
    name: 'Imagery: the satellite link (pick store)',
    draw: () => <Pick what="The satellite link" keyName="imagery-satellite" />,
    title: BODY,
    describe: body('The satellite link'),
    send: 'press',
  },
  {
    name: 'Hazards: demote (sendFor)',
    draw: () => <Act what="The demotion" />,
    title: BODY,
    describe: body('The demotion'),
    send: 'press',
  },
  {
    name: 'Standing: the form (sendFor)',
    draw: () => <StandingForm />,
    title: BODY,
    describe: body('Set dormant'),
    send: 'form',
  },
  {
    name: 'The frame: the map boost (pick store)',
    draw: () => <Pick what="The map boost" keyName="boost" />,
    title: BODY,
    describe: body('The map boost'),
    send: 'press',
  },
  {
    name: 'People: a lever pressed at once',
    draw: () => <Lever />,
    title: 'Not changed · Rob Tremblay',
    describe: words,
    send: 'press',
  },
  {
    name: 'People: a lever behind its dialog',
    draw: () => <LeverDialog />,
    title: 'Not changed · Rob Tremblay',
    describe: words,
    send: 'dialog',
  },
  {
    name: 'People: the record sheet’s levers',
    draw: () => <RecordDialog />,
    title: 'Not changed · Rob Tremblay',
    describe: words,
    send: 'dialog',
  },
  {
    name: 'Undo: from a toast or History (no reason)',
    draw: () => <Undo needsReason={false} />,
    title: 'Not undone',
    describe: words,
    send: 'press',
  },
  {
    name: 'Undo: with a reason (its dialog)',
    draw: () => <Undo needsReason />,
    title: 'Not undone',
    describe: words,
    send: 'dialog',
  },
  {
    name: 'Legacy: a write with no catch',
    draw: () => <LegacyButtonWrite />,
    title: 'Not saved',
    describe: words,
    send: 'press',
  },
  {
    name: 'Legacy: behind a reason dialog',
    draw: () => <LegacyDialog />,
    title: 'Not saved',
    describe: words,
    send: 'legacy dialog',
  },
  {
    name: 'Legacy: moderator actions',
    draw: () => <ModeratorActions targetType="comment" targetId="c1" />,
    title: 'Not saved',
    describe: words,
    send: 'moderator dialog',
  },
];

/** The text a dialog or form keeps, once its write has gone. */
const TYPED = 'Posted all round';

async function start(row: Row, user: ReturnType<typeof userEvent.setup>) {
  switch (row.send) {
    case 'press':
      await user.click(screen.getByRole('button', { name: 'Send' }));
      return;
    case 'dialog': {
      await user.click(screen.getByRole('button', { name: 'Open' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.type(within(dialog).getByRole('textbox'), TYPED);
      await user.click(within(dialog).getByRole('button', { name: /^(Send|Undo)/ }));
      return;
    }
    case 'form':
      await user.click(screen.getByRole('radio', { name: /^Dormant/ }));
      await user.type(screen.getByRole('textbox', { name: 'Note for skaters · optional' }), TYPED);
      await user.click(screen.getByRole('button', { name: /Set dormant/ }));
      return;
    case 'legacy dialog': {
      await user.click(screen.getByRole('button', { name: 'Open' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), TYPED);
      await user.click(within(dialog).getByRole('button', { name: 'Send' }));
      return;
    }
    case 'moderator dialog': {
      await user.click(screen.getByRole('button', { name: 'Moderate' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), TYPED);
      await user.click(within(dialog).getByRole('button', { name: 'Hide' }));
      return;
    }
  }
}

/** Whatever asked, if it is drawn: the dialog (or the form) and the text it keeps. */
function asker(row: Row): HTMLElement | null {
  if (row.send === 'press') return null;
  if (row.send === 'form') return document.querySelector('[data-slot="standing-form"]');
  return screen.queryByRole(row.send === 'dialog' ? 'alertdialog' : 'dialog');
}

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));

/**
 * The table: every row at every place, and every row with every answer — each answer taken in turn
 * across a row's places, so each pair of dimensions is covered in full (row × place, row × answer,
 * place × answer) without rendering every triple.
 */
const CELLS = ROWS.flatMap((row, r) =>
  PLACES.map((place, p) => {
    const [answer, error, why] = ANSWERS[(r + p) % ANSWERS.length] as (typeof ANSWERS)[number];
    return { row, answer, error, why, place };
  }),
);

describe('a server’s answer that refuses, from every write, wherever the operator is', () => {
  it.each(CELLS)(
    '$row.name — $answer — the operator at $place: one toast, nothing printed',
    async ({ row, error, why, place }) => {
      const user = userEvent.setup({ delay: null });
      const view = render(<App place="the same place">{row.draw()}</App>);
      await start(row, user);
      expect(mocks.pending).toHaveLength(1);
      // The operator is wherever they went when the answer comes.
      view.rerender(<App place={place}>{row.draw()}</App>);
      await act(async () => {
        mocks.pending.shift()?.reject(error());
      });
      await settle();

      // Exactly one toast: its subject and what was not changed, the server's words, held.
      expect(mocks.toasts).toEqual([
        { title: row.title, description: row.describe(why), tone: 'bad', timeout: 0 },
      ]);
      // Nothing of the server's printed anywhere on the page.
      expect(screen.queryByText(why, { exact: false })).toBeNull();
      // What asked, if the operator stayed: still open, with what was typed.
      if (place === 'the same place' && row.send !== 'press') {
        const open = asker(row);
        expect(open).not.toBeNull();
        expect(within(open as HTMLElement).getByRole('textbox', { name: /.*/ })).toHaveValue(TYPED);
      }
      view.unmount();
    },
  );
});
