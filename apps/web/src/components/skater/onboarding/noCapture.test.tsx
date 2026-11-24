import { KNOW_BEFORE_YOU_GO, receiptLine } from '@skating/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';

import { BOARD_NOON } from '@/test/boardNow';

import { AccountStep } from './AccountStep';
import { QuestionCard } from './QuestionCard';
import { ReceiptStep } from './TermsStep';
import { ProfileStep } from './WelcomeSteps';

/**
 * **What autocapture must never carry** (B03 §9.10, D240): a click's on-screen label is what
 * PostHog's autocapture records, so the date of birth (a month picked by name), the name and
 * username fields, the quiz picks (a wrong answer clicked) and the receipt's email line each sit
 * inside `ph-no-capture`. The events report counts and shapes through `lib/analytics` instead.
 */
const masked = (el: Element) => el.closest('.ph-no-capture') !== null;

beforeAll(() => {
  // Base UI waits on an element's animations before it unmounts; jsdom has none to wait on.
  if (!('getAnimations' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'getAnimations', { value: () => [] });
  }
  // Base UI's Select measures and animates its popup; jsdom has neither.
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
});

const noop = () => {};

describe('ph-no-capture', () => {
  it('covers the name, the username and every part of the date of birth', () => {
    render(
      <AccountStep
        now={BOARD_NOON}
        email="kate.donovan@gmail.com"
        useAvailability={() => 'free'}
        onContinue={noop}
        onSignOut={noop}
      />,
    );
    for (const name of ['Your full name', 'Username', 'Day', 'Year']) {
      expect(masked(screen.getByRole('textbox', { name }))).toBe(true);
    }
    expect(masked(screen.getByRole('combobox', { name: 'Month' }))).toBe(true);
    // The signed-in address in the foot too.
    expect(masked(screen.getByText('kate.donovan@gmail.com'))).toBe(true);
  });

  it('covers the month’s list, which portals out of the field', async () => {
    const user = userEvent.setup();
    render(
      <AccountStep
        now={BOARD_NOON}
        email={null}
        useAvailability={() => 'free'}
        onContinue={noop}
        onSignOut={noop}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: 'Month' }));
    const march = await screen.findByRole('option', { name: 'March' });
    expect(masked(march)).toBe(true);
  });

  it('covers both of a question’s answers', () => {
    const question = KNOW_BEFORE_YOU_GO.questions[0];
    if (!question) throw new Error('No questions');
    render(<QuestionCard question={question} state="ask" onPick={noop} />);
    for (const answer of [question.right, question.wrong]) {
      expect(masked(screen.getByRole('button', { name: new RegExp(answer.slice(0, 12)) }))).toBe(
        true,
      );
    }
  });

  it('covers the receipt’s sent-to line', () => {
    render(
      <ReceiptStep
        step={2}
        line={receiptLine('sent', 'kate.donovan@gmail.com')}
        questionsDue
        email={null}
        onContinue={noop}
        onSignOut={noop}
      />,
    );
    const line = screen.getByText('kate.donovan@gmail.com', { selector: 'b' });
    expect(masked(line)).toBe(true);
  });

  it('covers the profile step’s bio and town', () => {
    render(
      <ProfileStep
        photo={null}
        draft={{ bio: 'Lunchtime skater', town: 'Hanover, NH', isPublic: true, showTown: true }}
        onDraftChange={noop}
        saving={false}
        skipping={false}
        email={null}
        onDone={noop}
        onSkip={noop}
        onSignOut={noop}
      />,
    );
    const card = screen.getByDisplayValue('Lunchtime skater');
    expect(masked(card)).toBe(true);
    expect(masked(screen.getByDisplayValue('Hanover, NH'))).toBe(true);
    // The switches are labels, not content: they stay countable.
    expect(within(document.body).getByRole('switch', { name: 'Public profile' })).toBeChecked();
  });
});
