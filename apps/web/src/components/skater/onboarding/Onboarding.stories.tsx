import {
  KNOW_BEFORE_YOU_GO,
  knowBeforeYouGoAnswers,
  ONBOARDING_COPY,
  receiptLine,
} from '@skating/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { AccountFields } from '@/lib/entryHold';
import { BOARD_NOON } from '@/test/boardNow';
import { stageGlobals } from '../auth/storyFrame';
import type { AddressLookup, AddressSuggestion } from '../settings/geocoder';
import { ProfilePhoto } from '../settings/ProfilePhoto';
import { AccountStep, type UsernameAvailability } from './AccountStep';
import {
  KnowBeforeYouGoFlow,
  type KnowBeforeYouGoPosition,
  type SeasonFacts,
} from './KnowBeforeYouGoFlow';
import type { TermsReaderVia } from './TermsReader';
import { ReceiptStep, TermsStep } from './TermsStep';
import { AddPhotoLabel, HomeStep, type ProfileDraft, ProfileStep } from './WelcomeSteps';

/**
 * Rows 10 and 11 of the *Onboarding* page: the way in, at 1440 × 900 on a desk and 390 × 844 on a
 * phone. Each board is a full screen in one mode (the region and the logo follow the root's mode,
 * as in the app); the desk boards come in both modes, the phone boards in dark. The frame is a
 * containing block, so the screen's fixed ground stays inside it, and its width is what the
 * screen's container query reads — a phone board draws the phone at any canvas width.
 *
 * The plays walk what matters: the keyboard path through the Account step, the terms locked until
 * their end has been on screen (inline and in the full-screen reader, out of which Esc returns),
 * keys 1 and 2 and Enter through the questions, a miss waiting for the right pick.
 */
const meta = {
  title: 'Skater/Onboarding',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const EMAIL = 'kate.donovan@gmail.com';
const FILL = 'h-full min-h-0';
const noop = () => {};

/** A board's frame: a containing block at the board's size. */
function Board({ phone = false, children }: { phone?: boolean; children: ReactNode }) {
  return (
    <div
      data-slot="board"
      className={
        phone
          ? 'relative h-[52.75rem] w-[24.375rem] overflow-hidden [transform:translateZ(0)]'
          : 'relative h-[56.25rem] w-[90rem] overflow-hidden [transform:translateZ(0)]'
      }
    >
      {children}
    </div>
  );
}

const desk = (mode: 'dark' | 'light' = 'dark') => ({ globals: stageGlobals(mode) });
const phone = desk('dark');

// ── Account (10.1, 10.2, 11.1) ─────────────────────────────────────────────────────────────

const KATE: AccountFields = {
  displayName: 'Kate Donovan',
  username: 'kdonovan',
  month: 11,
  day: '2',
  year: '1988',
};

const free = (): UsernameAvailability => 'free';
const onContinue = fn();

function Account({
  initial,
  phone: onPhone = false,
  availability = free,
}: {
  initial?: AccountFields;
  phone?: boolean;
  availability?: (username: string | null) => UsernameAvailability;
}) {
  return (
    <Board phone={onPhone}>
      <AccountStep
        className={FILL}
        initial={initial ?? null}
        now={BOARD_NOON}
        email={EMAIL}
        useAvailability={availability}
        onContinue={onContinue}
        onSignOut={noop}
      />
    </Board>
  );
}

/**
 * 10.1 — Create your account, filled in. Enter from the year continues, with the values checked and
 * normalized: nothing is written here.
 */
export const AccountDesk: Story = {
  ...desk(),
  render: () => <Account initial={KATE} />,
  play: async ({ canvasElement }) => {
    onContinue.mockClear();
    const c = within(canvasElement);
    await expect(c.getByText('1 of 5')).toBeVisible();
    await expect(c.getByRole('button', { name: 'Continue' })).toBeEnabled();
    await userEvent.click(c.getByRole('textbox', { name: 'Year' }));
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(onContinue).toHaveBeenCalledWith(KATE, {
        displayName: 'Kate Donovan',
        username: 'kdonovan',
        dateOfBirth: Date.UTC(1988, 10, 2),
      }),
    );
  },
};

export const AccountDeskLight: Story = { ...AccountDesk, ...desk('light') };

/**
 * 10.1, empty: focus opens on the name, and the keyboard runs name → username → month → day →
 * year → (the primary is off, so skipped) → sign out. The month is picked by name, from the keys.
 */
export const AccountEmpty: Story = {
  ...desk(),
  render: () => <Account />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole('textbox', { name: 'Your full name' })).toHaveFocus());
    await userEvent.tab();
    await expect(c.getByRole('textbox', { name: 'Username' })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('combobox', { name: 'Month' })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('textbox', { name: 'Day' })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('textbox', { name: 'Year' })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getAllByRole('button', { name: 'Sign out' }).at(-1)).toHaveFocus();
    await expect(c.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await expect(c.getByText(ONBOARDING_COPY.account.dateOfBirthHint)).toBeVisible();
  },
};

/** 10.2 — under 18: every part of the date amber, the line under it, and *Continue* off. */
export const AccountUnderEighteen: Story = {
  ...desk(),
  render: () => <Account initial={{ ...KATE, month: 3, day: '14', year: '2010' }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('alert')).toHaveTextContent('You must be at least 18 to use Gli.');
    await expect(c.getByRole('button', { name: 'Continue' })).toBeDisabled();
    for (const name of ['Day', 'Year']) {
      await expect(c.getByRole('textbox', { name })).toHaveAttribute('aria-invalid', 'true');
    }
    await expect(c.getByRole('combobox', { name: 'Month' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // Fixed by the year: the line goes, the hint comes back.
    await userEvent.clear(c.getByRole('textbox', { name: 'Year' }));
    await userEvent.type(c.getByRole('textbox', { name: 'Year' }), '1990');
    await waitFor(() => expect(c.queryByRole('alert')).toBeNull());
    await expect(c.getByRole('button', { name: 'Continue' })).toBeEnabled();
  },
};

/** Not drawn: the live check says the handle is taken — said in the field, three to try. */
export const AccountUsernameTaken: Story = {
  ...desk(),
  render: () => (
    <Account initial={KATE} availability={(u) => (u === 'kdonovan' ? 'taken' : 'free')} />
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(await c.findByText(/@kdonovan is taken/)).toBeVisible();
    await expect(c.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await userEvent.click(c.getByRole('button', { name: '@katedonovan' }));
    await expect(c.getByRole('textbox', { name: 'Username' })).toHaveValue('katedonovan');
    await waitFor(() => expect(c.queryByText(/is taken/)).toBeNull());
    await expect(c.getByRole('button', { name: 'Continue' })).toBeEnabled();
  },
};

/** 11.1 — the Account step on a phone: the primary under the thumb. */
export const AccountPhone: Story = { ...phone, render: () => <Account initial={KATE} phone /> };

// ── Terms (10.3–10.5, 11.2–11.5, and the full-screen reader) ───────────────────────────────

const onRecord = fn();
const onEndSpy = fn();

/** The Terms step with the page's half stood in: an end reached is recorded at once. */
function Terms({
  phone: onPhone = false,
  read: initiallyRead = false,
  checked = false,
}: {
  phone?: boolean;
  read?: boolean;
  checked?: boolean;
}) {
  const [read, setRead] = useState(initiallyRead);
  return (
    <Board phone={onPhone}>
      <TermsStep
        className={FILL}
        step={2}
        read={read}
        armed={!read}
        busy={false}
        email={EMAIL}
        initialChecked={checked}
        onEnd={(via: TermsReaderVia) => {
          onEndSpy(via);
          setRead(true);
        }}
        onRecord={onRecord}
        onSignOut={noop}
      />
    </Board>
  );
}

const readerViewport = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('[data-slot="terms-reader"] [data-slot="scroll-area-viewport"]');

/** 10.3 — locked: the reader at its top, the box off, *Record acceptance* off. */
export const TermsLocked: Story = {
  ...desk(),
  render: () => <Terms />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true');
    await expect(c.getByRole('button', { name: 'Record acceptance' })).toBeDisabled();
    // The notice is a link either way, never gated by the reading.
    await expect(c.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute(
      'target',
      '_blank',
    );
    await expect(c.getByText('2 of 5')).toBeVisible();
  },
};

export const TermsLockedLight: Story = { ...TermsLocked, ...desk('light') };

/**
 * 10.3 → 10.4 — read to the end: the end marker scrolled into the window unlocks the box, the meta
 * line says so, Space ticks it, and *Record acceptance* records.
 */
export const TermsReadToTheEnd: Story = {
  ...desk(),
  render: () => <Terms />,
  play: async ({ canvasElement }) => {
    onEndSpy.mockClear();
    onRecord.mockClear();
    const c = within(canvasElement);
    await expect(c.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true');
    const viewport = readerViewport(canvasElement);
    if (!viewport) throw new Error('The reader’s window is missing.');
    viewport.scrollTop = viewport.scrollHeight;
    await waitFor(() => expect(onEndSpy).toHaveBeenCalledWith('inline'));
    await waitFor(() => expect(c.getByRole('checkbox')).not.toHaveAttribute('aria-disabled'));
    await expect(c.getByText(/Version \d{4}-\d{2}-\d{2} · Read to the end/)).toBeVisible();
    c.getByRole('checkbox').focus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(c.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true'));
    await userEvent.click(c.getByRole('button', { name: 'Record acceptance' }));
    await expect(onRecord).toHaveBeenCalledOnce();
  },
};

/** 10.4 as drawn: read, the box ticked, the window at its end. */
export const TermsRead: Story = {
  ...desk(),
  render: () => <Terms read checked />,
  play: async ({ canvasElement }) => {
    const viewport = readerViewport(canvasElement);
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    await expect(
      within(canvasElement).getByRole('button', { name: 'Record acceptance' }),
    ).toBeEnabled();
  },
};

export const TermsReadLight: Story = { ...TermsRead, ...desk('light') };

/**
 * Not drawn — *Open in full-screen*: the kit Dialog at its viewer size, the same text and end
 * marker. Reaching its end counts (`fullscreen`); Esc returns with the box unlocked.
 */
export const TermsFullScreen: Story = {
  ...desk(),
  render: () => <Terms />,
  play: async ({ canvasElement }) => {
    onEndSpy.mockClear();
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: /Open in full-screen/ }));
    const page = within(canvasElement.ownerDocument.body);
    await page.findByRole('dialog', { name: 'Terms of use' });
    await waitFor(() => {
      const body = canvasElement.ownerDocument.querySelector<HTMLElement>(
        '[role="dialog"] [data-slot="dialog-body"]',
      );
      if (!body) throw new Error('The full-screen reader has no body yet.');
      body.scrollTop = body.scrollHeight;
      expect(onEndSpy).toHaveBeenCalledWith('fullscreen');
    });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
    await expect(c.getByRole('checkbox')).not.toHaveAttribute('aria-disabled');
  },
};

/** 11.2 — the phone reads on the page: the reader is the screen, the agreement in the foot. */
export const TermsLockedPhone: Story = { ...phone, render: () => <Terms phone /> };

/** 11.3 — reading: the hairline under the bar fills with the scroll. */
export const TermsReadingPhone: Story = {
  ...phone,
  render: () => <Terms phone />,
  play: async ({ canvasElement }) => {
    const body = canvasElement.querySelector<HTMLElement>('[data-slot="entry-body"]');
    if (!body) throw new Error('The phone’s page is missing.');
    body.scrollTop = (body.scrollHeight - body.clientHeight) * 0.46;
    await waitFor(() => {
      const bar = canvasElement.querySelector<HTMLElement>(
        '[data-slot="entry-read-progress"] > span',
      );
      // A width set as a percentage of the bar: read the number, never the string.
      expect(Number.parseFloat(bar?.style.width ?? '0')).toBeGreaterThan(30);
    });
    await expect(within(canvasElement).getByRole('checkbox')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

/** 11.4 — read to the end on a phone: the page scrolled to its end unlocks the box. */
export const TermsReadPhone: Story = {
  ...phone,
  render: () => <Terms phone />,
  play: async ({ canvasElement }) => {
    const body = canvasElement.querySelector<HTMLElement>('[data-slot="entry-body"]');
    if (!body) throw new Error('The phone’s page is missing.');
    body.scrollTop = body.scrollHeight;
    await waitFor(() =>
      expect(within(canvasElement).getByRole('checkbox')).not.toHaveAttribute('aria-disabled'),
    );
  },
};

const SENT = receiptLine('sent', EMAIL);

function Receipt({
  phone: onPhone = false,
  due = true,
  line = SENT,
  onContinue: go = noop,
}: {
  phone?: boolean;
  due?: boolean;
  line?: ReturnType<typeof receiptLine> | null;
  onContinue?: () => void;
}) {
  return (
    <Board phone={onPhone}>
      <ReceiptStep
        className={FILL}
        step={2}
        line={line}
        questionsDue={due}
        email={EMAIL}
        onContinue={go}
        onSignOut={noop}
      />
    </Board>
  );
}

const onReceipt = fn();

/** 10.5 — recorded: where the copy went, no times, then the questions ahead. */
export const TermsRecorded: Story = {
  ...desk(),
  render: () => <Receipt onContinue={onReceipt} />,
  play: async ({ canvasElement }) => {
    onReceipt.mockClear();
    const c = within(canvasElement);
    await expect(c.getByText(EMAIL, { selector: 'b' })).toBeVisible();
    await expect(c.getByText('Next: Know Before You Go')).toBeVisible();
    await waitFor(() =>
      expect(c.getByRole('button', { name: 'Start the questions' })).toHaveFocus(),
    );
    await userEvent.keyboard('{Enter}');
    await expect(onReceipt).toHaveBeenCalledOnce();
  },
};

export const TermsRecordedLight: Story = { ...TermsRecorded, ...desk('light') };

/** Not drawn — no copy went, and no questions are due: the drafted line, and *Continue*. */
export const TermsRecordedNoCopy: Story = {
  ...desk(),
  render: () => <Receipt due={false} line={receiptLine('not_sent', null)} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText(ONBOARDING_COPY.receipt.notSent)).toBeVisible();
    await expect(c.queryByText('Next: Know Before You Go')).toBeNull();
    await expect(c.getByRole('button', { name: 'Continue' })).toBeVisible();
  },
};

/** 11.5 — recorded, on a phone. */
export const TermsRecordedPhone: Story = { ...phone, render: () => <Receipt phone /> };

// ── Know Before You Go (10.6–10.9, 10.13, 11.6–11.9, 11.13) ────────────────────────────────

const onComplete = fn();
const onSeasonSignOut = fn();

const SEASON: SeasonFacts = {
  label: 'Winter 2027–28',
  displayName: 'Kate Donovan',
  lastAt: Date.UTC(2026, 10, 16, 17),
  timeZone: 'America/New_York',
};

function Questions({
  phone: onPhone = false,
  initial,
  flavor = 'never',
}: {
  phone?: boolean;
  initial?: KnowBeforeYouGoPosition;
  flavor?: 'never' | 'season';
}) {
  return (
    <Board phone={onPhone}>
      <KnowBeforeYouGoFlow
        className={FILL}
        step={3}
        flavor={flavor}
        season={SEASON}
        initial={initial}
        busy={false}
        email={EMAIL}
        onComplete={onComplete}
        onSeasonSignOut={onSeasonSignOut}
        onSignOut={noop}
      />
    </Board>
  );
}

const ASK_3 = { stage: 'question', index: 2, state: 'ask' } as const;
const lit = (root: HTMLElement) =>
  root.querySelectorAll('[data-slot="question-cells"] [data-lit]').length;
/** The key that picks a question's right (or wrong) answer: its place in the drawn order. */
const keyFor = (index: number, right: boolean) => {
  const question = KNOW_BEFORE_YOU_GO.questions[index];
  if (!question) throw new Error(`No question ${index}.`);
  return String(knowBeforeYouGoAnswers(question).findIndex((a) => a.right === right) + 1);
};

/**
 * 10.6 — a question: seven cells, the prompt, two answers with their keys, the feedback line's room
 * kept, *Next question* off. Then the keyboard path: the wrong key is a miss (10.8) and the button
 * stays off; the right key settles it (10.7) and the button takes focus, so Enter goes on.
 */
export const QuestionAsk: Story = {
  ...desk(),
  render: () => <Questions initial={ASK_3} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(lit(canvasElement)).toBe(2);
    await expect(c.getByRole('button', { name: 'Next question' })).toBeDisabled();
    await expect(c.getByText('1', { selector: 'kbd' })).toBeVisible();
    await userEvent.keyboard(keyFor(2, false));
    await expect(await c.findByText('Not quite.')).toBeVisible();
    await expect(c.getByText(/Pick the correct answer to continue\./)).toBeVisible();
    await expect(c.getByRole('button', { name: 'Next question' })).toBeDisabled();
    await userEvent.keyboard(keyFor(2, true));
    await expect(await c.findByText('Correct.')).toBeVisible();
    await waitFor(() => expect(c.getByRole('button', { name: 'Next question' })).toHaveFocus());
    await expect(lit(canvasElement)).toBe(3);
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(c.getByText(KNOW_BEFORE_YOU_GO.questions[3]?.prompt ?? '')).toBeVisible(),
    );
    await expect(c.getByRole('button', { name: 'Next question' })).toBeDisabled();
  },
};

export const QuestionAskLight: Story = { ...QuestionAsk, ...desk('light'), play: undefined };

/** 10.7 — correct: the pick outlined with a check, the other dimmed, "Correct." and the why. */
export const QuestionCorrect: Story = {
  ...desk(),
  render: () => <Questions initial={{ ...ASK_3, state: 'right' }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Correct.')).toBeVisible();
    await expect(c.getByRole('button', { name: 'Next question' })).toBeEnabled();
  },
};

export const QuestionCorrectLight: Story = { ...QuestionCorrect, ...desk('light') };

/** 10.8 — not quite: the miss amber with a cross; the right answer still waits for its press. */
export const QuestionNotQuite: Story = {
  ...desk(),
  render: () => <Questions initial={{ stage: 'question', index: 3, state: 'miss' }} />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'Next question' })).toBeDisabled();
    const picks = canvasElement.querySelectorAll<HTMLElement>('[data-slot="question-pick"]');
    const right = [...picks].find((p) => p.dataset.look === 'open');
    if (!right) throw new Error('The right answer should still be open.');
    await userEvent.click(right);
    await waitFor(() => expect(c.getByRole('button', { name: 'Next question' })).toBeEnabled());
  },
};

export const QuestionNotQuiteLight: Story = {
  ...QuestionNotQuite,
  ...desk('light'),
  play: undefined,
};

/** The seventh question: *Finish*, and Enter brings up all seven. */
export const QuestionLast: Story = {
  ...desk(),
  render: () => <Questions initial={{ stage: 'question', index: 6, state: 'ask' }} />,
  play: async ({ canvasElement }) => {
    onComplete.mockClear();
    const c = within(canvasElement);
    await userEvent.keyboard(keyFor(6, true));
    await waitFor(() => expect(c.getByRole('button', { name: 'Finish' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await expect(await c.findByText('Great work! You got them all right')).toBeVisible();
    await expect(canvasElement.querySelectorAll('[data-slot="all-seven"] li')).toHaveLength(7);
    await userEvent.click(c.getByRole('button', { name: 'Continue' }));
    await expect(onComplete).toHaveBeenCalledOnce();
  },
};

/** 10.9 — all seven, as the skater would say them; *Continue* writes the completion. */
export const QuestionsAllSeven: Story = {
  ...desk(),
  render: () => <Questions initial={{ stage: 'done', index: 6, state: 'right' }} />,
};

export const QuestionsAllSevenLight: Story = { ...QuestionsAllSeven, ...desk('light') };

/**
 * 10.13 — a new season on the ice: what's on file, *Start the questions*, or *Not now — sign out*.
 * No *Signed in as* foot: the second button is the way out.
 */
export const NewSeason: Story = {
  ...desk(),
  render: () => <Questions flavor="season" />,
  play: async ({ canvasElement }) => {
    onSeasonSignOut.mockClear();
    const c = within(canvasElement);
    await expect(c.getByText('Winter 2027–28')).toBeVisible();
    await expect(c.getByText(/Welcome back, Kate\./)).toBeVisible();
    await expect(c.getByText('Last answered Nov 16, 2026')).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="entry-foot"]')).toBeNull();
    await userEvent.click(c.getByRole('button', { name: 'Not now — sign out' }));
    await expect(onSeasonSignOut).toHaveBeenCalledOnce();
    await userEvent.click(c.getByRole('button', { name: 'Start the questions' }));
    await waitFor(() =>
      expect(c.getByText(KNOW_BEFORE_YOU_GO.questions[0]?.prompt ?? '')).toBeVisible(),
    );
  },
};

export const NewSeasonLight: Story = { ...NewSeason, ...desk('light'), play: undefined };

/** 11.6 */
export const QuestionAskPhone: Story = {
  ...phone,
  render: () => <Questions phone initial={ASK_3} />,
};
/** 11.7 */
export const QuestionCorrectPhone: Story = {
  ...phone,
  render: () => <Questions phone initial={{ ...ASK_3, state: 'right' }} />,
};
/** 11.8 */
export const QuestionNotQuitePhone: Story = {
  ...phone,
  render: () => <Questions phone initial={{ stage: 'question', index: 3, state: 'miss' }} />,
  play: async ({ canvasElement }) => {
    // No keys on a phone: the caps are the desk's.
    const kbd = canvasElement.querySelector<HTMLElement>('[data-slot="question-pick"] kbd');
    await expect(kbd).not.toBeVisible();
  },
};
/** 11.9 */
export const QuestionsAllSevenPhone: Story = {
  ...phone,
  render: () => <Questions phone initial={{ stage: 'done', index: 6, state: 'right' }} />,
};
/** 11.13 */
export const NewSeasonPhone: Story = {
  ...phone,
  render: () => <Questions phone flavor="season" />,
};

// ── Home and Profile (10.10–10.12, 11.10–11.12) ────────────────────────────────────────────

const ATTRIBUTION = 'Powered by Geoapify | © OpenStreetMap contributors';
const SUGGESTIONS: AddressSuggestion[] = [
  {
    label: '14 School Street, Hanover, NH 03755, USA',
    lat: 43.7,
    lng: -72.29,
    town: 'Hanover, NH',
  },
  {
    label: '14 School Street, Lebanon, NH 03766, USA',
    lat: 43.64,
    lng: -72.25,
    town: 'Lebanon, NH',
  },
  {
    label: '14 School Street, Enfield, NH 03748, USA',
    lat: 43.64,
    lng: -72.14,
    town: 'Enfield, NH',
  },
  {
    label: '14 Schoolhouse Road, Canaan, NH 03741, USA',
    lat: 43.65,
    lng: -72.01,
    town: 'Canaan, NH',
  },
];

const onPick = fn();

function Home({ phone: onPhone = false, typing = false }: { phone?: boolean; typing?: boolean }) {
  const lookup: AddressLookup = typing
    ? { state: 'ok', attribution: ATTRIBUTION, suggestions: SUGGESTIONS }
    : { state: 'idle', attribution: ATTRIBUTION };
  const picked = SUGGESTIONS[0] ?? null;
  return (
    <Board phone={onPhone}>
      <HomeStep
        className={FILL}
        address={typing ? '14 School' : '14 School Street, Hanover, NH 03755'}
        onAddressChange={noop}
        lookup={lookup}
        chosen={typing ? null : picked}
        onPick={onPick}
        locate="idle"
        saving={false}
        skipping={false}
        email={EMAIL}
        onUseLocation={noop}
        onSave={noop}
        onSkip={noop}
        onSignOut={noop}
      />
    </Board>
  );
}

/** 10.10 — typing: Settings' own suggestions, the first lit; ↓ then Enter picks the second. */
export const HomeTyping: Story = {
  ...desk(),
  render: () => <Home typing />,
  play: async ({ canvasElement }) => {
    onPick.mockClear();
    const c = within(canvasElement);
    await expect(c.getAllByRole('option')).toHaveLength(4);
    await expect(c.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
    c.getByRole('combobox').focus();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(onPick).toHaveBeenCalledWith(SUGGESTIONS[1]);
  },
};

export const HomeTypingLight: Story = { ...HomeTyping, ...desk('light'), play: undefined };

/** 10.11 — the picked address, "or", *Use my current location*, and the two buttons. */
export const HomePicked: Story = {
  ...desk(),
  render: () => <Home />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
    await expect(c.getByRole('button', { name: 'Use my current location' })).toBeVisible();
    await expect(c.getByText('4 of 5')).toBeVisible();
  },
};

export const HomePickedLight: Story = { ...HomePicked, ...desk('light') };

/** 11.10 */
export const HomeTypingPhone: Story = { ...phone, render: () => <Home phone typing /> };
/** 11.11 */
export const HomePickedPhone: Story = { ...phone, render: () => <Home phone /> };

const PROFILE: ProfileDraft = {
  bio: 'Lunchtime skater out of Hanover. Mostly Mascoma and Crystal.',
  town: 'Hanover, NH',
  isPublic: true,
  showTown: true,
};

function Profile({ phone: onPhone = false }: { phone?: boolean }) {
  const [draft, setDraft] = useState(PROFILE);
  return (
    <Board phone={onPhone}>
      <ProfileStep
        className={FILL}
        photo={
          <ProfilePhoto
            name="Kate Donovan"
            imageUrl={undefined}
            busy={null}
            error={null}
            offline={false}
            onChange={noop}
            onRemove={async () => true}
            words={{ add: <AddPhotoLabel />, hint: ONBOARDING_COPY.profile.photoHint }}
          />
        }
        draft={draft}
        onDraftChange={setDraft}
        saving={false}
        skipping={false}
        email={EMAIL}
        onDone={noop}
        onSkip={noop}
        onSignOut={noop}
      />
    </Board>
  );
}

/** 10.12 — complete your profile: the photo, Bio, Town from the address, both switches on. */
export const ProfileStepDesk: Story = {
  ...desk(),
  render: () => <Profile />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'Add a photo' })).toBeVisible();
    await expect(c.getByRole('switch', { name: 'Public profile' })).toBeChecked();
    await expect(c.getByRole('switch', { name: 'Show my town' })).toBeChecked();
    await userEvent.click(c.getByRole('switch', { name: 'Show my town' }));
    await waitFor(() => expect(c.getByRole('switch', { name: 'Show my town' })).not.toBeChecked());
  },
};

export const ProfileStepLight: Story = { ...ProfileStepDesk, ...desk('light'), play: undefined };

/** 11.12 */
export const ProfileStepPhone: Story = { ...phone, render: () => <Profile phone /> };
