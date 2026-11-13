import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { RISK_ACK_COPY } from '../../../lib/riskAck';
import { SkaterPair } from '../storySupport';
import { OnboardingForm } from './OnboardingForm';
import type { OnboardingRefusal } from './onboarding';
import { ReackForm } from './ReackForm';
import { SystemStage } from './SystemStage';
import { AUTH_PAIR, stageGlobals } from './storyFrame';

const meta = {
  title: 'Skater/Sign-in/Onboarding',
  component: OnboardingForm,
  parameters: { layout: 'fullscreen' },
  args: {
    email: 'kate.donovan@gmail.com',
    onSubmit: fn(async (): Promise<OnboardingRefusal | null> => null),
    onSignOut: fn(),
  },
  render: (args) => (
    <SystemStage>
      <OnboardingForm {...args} />
    </SystemStage>
  ),
} satisfies Meta<typeof OnboardingForm>;

export default meta;
type Story = StoryObj<typeof meta>;

const READY = { displayName: 'Kate Donovan', username: 'kdonovan', dob: '1988-11-02', ack: true };

/**
 * 8.5 — empty. Focus opens on the name, and the keyboard path runs name → username → date of birth
 * → the acknowledgment → the two documents → the primary (off) is skipped → sign out.
 */
export const Empty: Story = {
  globals: stageGlobals('dark'),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(c.getByRole('textbox', { name: 'Your full name' })).toHaveFocus());
    await userEvent.tab();
    await expect(c.getByRole('textbox', { name: 'Username' })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('textbox', { name: 'Date of birth' })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('checkbox', { name: RISK_ACK_COPY })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('link', { name: /Privacy notice/ })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('link', { name: /Terms \(interim\)/ })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await expect(c.getByRole('button', { name: 'Start skating' })).toBeDisabled();
  },
};

/** 8.6 — under 16: the gate says so in the field, and the primary stays off. */
export const UnderSixteen: Story = {
  globals: stageGlobals('dark'),
  args: { initial: { ...READY, dob: '2011-03-14', ack: false } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('You must be at least 16 to use Gli.')).toBeVisible();
    await expect(c.getByRole('button', { name: 'Start skating' })).toBeDisabled();
  },
};

/** 8.7 — ready: every field good, the box ticked; Enter from a field submits. */
export const Ready: Story = {
  globals: stageGlobals('dark'),
  args: { initial: READY },
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    await expect(c.getByRole('button', { name: 'Start skating' })).toBeEnabled();
    await userEvent.click(c.getByRole('textbox', { name: 'Date of birth' }));
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(args.onSubmit).toHaveBeenCalledWith({
        displayName: 'Kate Donovan',
        username: 'kdonovan',
        dateOfBirth: Date.UTC(1988, 10, 2),
      }),
    );
  },
};

/** 8.16 — ready, light. */
export const ReadyLight: Story = { ...Ready, globals: stageGlobals('light') };

/** 8.18 — the username is taken: said in the field, with three to try, one press each. */
export const UsernameTaken: Story = {
  globals: stageGlobals('dark'),
  args: {
    initial: READY,
    onSubmit: fn(async (): Promise<OnboardingRefusal | null> => ({ kind: 'taken' })),
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('button', { name: 'Start skating' }));
    await expect(await c.findByText(/@kdonovan is taken/)).toBeVisible();
    await waitFor(() => expect(c.getByRole('textbox', { name: 'Username' })).toHaveFocus());
    await expect(c.getByRole('button', { name: 'Start skating' })).toBeDisabled();
    await userEvent.click(c.getByRole('button', { name: '@katedonovan' }));
    await expect(c.getByRole('textbox', { name: 'Username' })).toHaveValue('katedonovan');
    await expect(c.queryByText(/is taken/)).toBeNull();
  },
};

/** 8.19 — a username that breaks the rule says the rule, as soon as a character can't be in one. */
export const UsernameNotAllowed: Story = {
  globals: stageGlobals('dark'),
  args: { initial: { ...READY, username: '' } },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole('textbox', { name: 'Username' }));
    await userEvent.keyboard('kate.d');
    await expect(c.getByRole('alert')).toHaveTextContent('Use 3 to 30 letters');
    await expect(c.getByRole('button', { name: 'Start skating' })).toBeDisabled();
  },
};

/** The form in skater dark and light, side by side, ready. */
export const Pair: Story = {
  args: { initial: READY },
  render: (args) => <SkaterPair {...AUTH_PAIR}>{() => <OnboardingForm {...args} />}</SkaterPair>,
};

/**
 * 8.8 — One quick thing. The acknowledgment is the legal copy itself; ticking it with Space turns the
 * primary on, and Enter accepts.
 */
export const Reack: StoryObj<typeof ReackForm> = {
  globals: stageGlobals('dark'),
  args: { onAccept: fn(async () => null), onSignOut: fn() },
  render: (args) => (
    <SystemStage>
      <ReackForm {...args} />
    </SystemStage>
  ),
  play: async ({ canvasElement, args }) => {
    const c = within(canvasElement);
    const accept = c.getByRole('button', { name: 'Accept and continue' });
    await expect(accept).toBeDisabled();
    await userEvent.tab();
    await expect(c.getByRole('checkbox', { name: RISK_ACK_COPY })).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(accept).toBeEnabled();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await expect(accept).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(args.onAccept).toHaveBeenCalledOnce());
  },
};
