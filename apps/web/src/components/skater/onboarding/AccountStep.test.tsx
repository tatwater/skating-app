import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AccountFields } from '@/lib/entryHold';
import { BOARD_NOON } from '@/test/boardNow';

import { AccountStep, type UsernameAvailability } from './AccountStep';

const KATE: AccountFields = {
  displayName: 'Kate Donovan',
  username: 'kdonovan',
  month: 11,
  day: '2',
  year: '1988',
};

function renderAccount({
  initial,
  taken,
  availability = () => 'free',
}: {
  initial?: AccountFields;
  taken?: string;
  availability?: (username: string | null) => UsernameAvailability;
} = {}) {
  const onContinue = vi.fn();
  const onSignOut = vi.fn();
  const asked = vi.fn(availability);
  render(
    <AccountStep
      initial={initial ?? null}
      taken={taken ?? null}
      now={BOARD_NOON}
      email="kate.donovan@gmail.com"
      useAvailability={asked}
      onContinue={onContinue}
      onSignOut={onSignOut}
    />,
  );
  return { onContinue, onSignOut, asked };
}

const field = (name: string) => screen.getByRole('textbox', { name });
const proceed = () => screen.getByRole('button', { name: 'Continue' });

describe('AccountStep', () => {
  it('opens on the name and keeps Continue off until the name, handle and date all pass', async () => {
    const user = userEvent.setup();
    renderAccount();
    await waitFor(() => expect(field('Your full name')).toHaveFocus());
    expect(proceed()).toBeDisabled();
    await user.keyboard('Kate Donovan');
    await user.type(field('Username'), 'KDonovan');
    await user.type(field('Day'), '2');
    await user.type(field('Year'), '1988');
    // No month yet: still a date being typed, so nothing is said and Continue waits.
    expect(proceed()).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('continues with the values checked and normalized, and writes nothing itself', async () => {
    const user = userEvent.setup();
    const { onContinue } = renderAccount({
      initial: { ...KATE, displayName: '  Kate   Donovan ', username: ' KDonovan ' },
    });
    await user.click(proceed());
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ username: ' KDonovan ' }), {
      displayName: 'Kate Donovan',
      username: 'kdonovan',
      dateOfBirth: Date.UTC(1988, 10, 2),
    });
  });

  it('holds the 18+ gate in the field: amber on every part, Continue off', () => {
    const { onContinue } = renderAccount({
      initial: { ...KATE, month: 3, day: '14', year: '2010' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('You must be at least 18 to use Gli.');
    expect(proceed()).toBeDisabled();
    expect(field('Day')).toHaveAttribute('aria-invalid', 'true');
    expect(field('Year')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('combobox', { name: 'Month' })).toHaveAttribute('aria-invalid', 'true');
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('turns 18 on the birthday itself, by the clock it is given', () => {
    // BOARD_NOON is 16 January 2027: born 16 January 2009 is 18 that day.
    renderAccount({ initial: { ...KATE, month: 1, day: '16', year: '2009' } });
    expect(proceed()).toBeEnabled();
  });

  it('says a date that isn’t one, once it is complete', () => {
    renderAccount({ initial: { ...KATE, month: 2, day: '31', year: '1990' } });
    expect(screen.getByRole('alert')).toHaveTextContent('That date doesn’t look right.');
    expect(proceed()).toBeDisabled();
  });

  it('asks the live check only for a handle that could be one', async () => {
    const user = userEvent.setup();
    const { asked } = renderAccount({ initial: { ...KATE, username: '' } });
    await user.type(field('Username'), 'k.');
    expect(asked).toHaveBeenLastCalledWith(null);
    await user.clear(field('Username'));
    await user.type(field('Username'), 'kdonovan');
    expect(asked).toHaveBeenLastCalledWith('kdonovan');
  });

  it('says a taken handle in the field with three to try, and one press takes one', async () => {
    const user = userEvent.setup();
    renderAccount({
      initial: KATE,
      availability: (u) => (u === 'kdonovan' ? 'taken' : 'free'),
    });
    expect(screen.getByText(/@kdonovan is taken/)).toBeInTheDocument();
    expect(proceed()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '@katedonovan' }));
    expect(field('Username')).toHaveValue('katedonovan');
    expect(screen.queryByText(/is taken/)).toBeNull();
    expect(proceed()).toBeEnabled();
  });

  it('marks the handle the acceptance refused, and opens on it', async () => {
    renderAccount({ initial: KATE, taken: 'kdonovan' });
    expect(screen.getByText(/@kdonovan is taken/)).toBeInTheDocument();
    await waitFor(() => expect(field('Username')).toHaveFocus());
  });

  it('says the username rule as soon as a character can’t be in one', async () => {
    const user = userEvent.setup();
    renderAccount({ initial: { ...KATE, username: '' } });
    await user.type(field('Username'), 'kate.d');
    expect(screen.getByRole('alert')).toHaveTextContent('Use 3 to 30 letters');
    expect(proceed()).toBeDisabled();
  });

  it('signs out from the foot', async () => {
    const user = userEvent.setup();
    const { onSignOut } = renderAccount();
    const [first] = screen.getAllByRole('button', { name: 'Sign out' });
    if (!first) throw new Error('No sign out');
    await user.click(first);
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.getByText('kate.donovan@gmail.com')).toBeInTheDocument();
  });
});
