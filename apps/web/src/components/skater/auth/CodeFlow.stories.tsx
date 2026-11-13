import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { SkaterPair } from '../storySupport';
import { ChipLink } from './ChipLink';
import { CodeFlow } from './CodeFlow';
import { SystemStage } from './SystemStage';
import { AUTH_PAIR, fakeAuthClient, stageGlobals } from './storyFrame';

const meta = {
  title: 'Skater/Sign-in/Code flow',
  component: CodeFlow,
  parameters: { layout: 'fullscreen' },
  args: {
    mode: 'sign-in',
    client: fakeAuthClient(),
    otherLink: <ChipLink link={<a href="#story" />}>Create an account</ChipLink>,
  },
} satisfies Meta<typeof CodeFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

const EMAIL = 'kate.donovan@gmail.com';
const about = <ChipLink link={<a href="#story" />}>About Gli</ChipLink>;

const emailBox = (c: HTMLElement) => within(c).getByRole('textbox', { name: 'Email address' });
const firstSlot = (c: HTMLElement) =>
  within(c)
    .getAllByRole('textbox')
    .find((el) => el.tabIndex === 0) as HTMLElement;

/** Email, then Enter, and the code step has focus in its first slot. */
async function toCodeStep(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  await waitFor(() => expect(emailBox(canvasElement)).toHaveFocus());
  await userEvent.keyboard(EMAIL);
  await userEvent.keyboard('{Enter}');
  await c.findByText('Check your email');
  await waitFor(() => expect(c.getByRole('textbox', { name: 'Code' })).toHaveFocus());
}

/**
 * 8.1 — Sign in, email. The keyboard path: focus opens in the field, Tab reaches the one primary,
 * then the way to sign up; the primary stays off until the address could be one.
 */
export const SignInEmail: Story = {
  globals: stageGlobals('dark'),
  render: (args) => (
    <SystemStage corner={about}>
      <CodeFlow {...args} />
    </SystemStage>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const send = c.getByRole('button', { name: 'Email me a code' });
    await waitFor(() => expect(emailBox(canvasElement)).toHaveFocus());
    await expect(send).toBeDisabled();
    await userEvent.keyboard(EMAIL);
    await expect(send).toBeEnabled();
    await userEvent.tab();
    await expect(send).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('link', { name: /Create an account/ })).toHaveFocus();
    await userEvent.tab();
    await expect(c.getByRole('link', { name: /About Gli/ })).toHaveFocus();
  },
};

/** 8.15 — the same, light. */
export const SignInEmailLight: Story = {
  ...SignInEmail,
  globals: stageGlobals('light'),
};

/**
 * 8.2 — the code, half typed. Enter on the email moved focus into the first slot; the resend waits
 * out its clock. Tab runs slots → the primary is skipped while off → the two quiet actions.
 */
export const SignInCode: Story = {
  globals: stageGlobals('dark'),
  render: SignInEmail.render,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await toCodeStep(canvasElement);
    await expect(c.getByText(EMAIL)).toBeVisible();
    await expect(c.getByRole('button', { name: /Send a new code · 0:\d\d/ })).toBeDisabled();
    await userEvent.keyboard('419');
    await expect(c.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await userEvent.tab();
    await expect(c.getByRole('button', { name: 'Use a different email' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    await expect(firstSlot(canvasElement)).toHaveFocus();
  },
};

/**
 * 8.3 — the wrong code. Enter submits a full code; the refusal is amber under the slots, focus
 * comes back to them, the primary stays off until the code changes, and a new code can be sent now.
 */
export const SignInWrongCode: Story = {
  globals: stageGlobals('dark'),
  render: SignInEmail.render,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await toCodeStep(canvasElement);
    await userEvent.keyboard('419207'.replace('207', '200'));
    await userEvent.keyboard('{Enter}');
    await expect(await c.findByRole('alert')).toHaveTextContent('That code doesn’t match');
    await waitFor(() => expect(firstSlot(canvasElement)).toHaveFocus());
    await expect(c.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    await expect(c.getByRole('button', { name: 'Send a new code' })).toBeEnabled();
  },
};

/** 8.4 — Sign up, email: the placeholder, the primary off until there's an address. */
export const SignUpEmail: Story = {
  globals: stageGlobals('dark'),
  args: {
    mode: 'sign-up',
    otherLink: <ChipLink link={<a href="#story" />}>Sign in</ChipLink>,
  },
  render: SignInEmail.render,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText('Join Gli')).toBeVisible();
    await expect(emailBox(canvasElement)).toHaveAttribute('placeholder', 'you@example.com');
    await expect(c.getByRole('button', { name: 'Email me a code' })).toBeDisabled();
  },
};

/** No account for that address: the field says so, in amber, and keeps focus. */
export const SignInUnknownEmail: Story = {
  globals: stageGlobals('dark'),
  render: SignInEmail.render,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await waitFor(() => expect(emailBox(canvasElement)).toHaveFocus());
    await userEvent.keyboard('nobody@example.com{Enter}');
    await expect(await c.findByRole('alert')).toHaveTextContent('There’s no Gli account');
    await waitFor(() => expect(emailBox(canvasElement)).toHaveFocus());
    await expect(emailBox(canvasElement)).toHaveAttribute('aria-invalid', 'true');
  },
};

/** The card in skater dark and light, side by side: the code step, refused. */
export const Pair: Story = {
  render: (args) => <SkaterPair {...AUTH_PAIR}>{() => <CodeFlow {...args} />}</SkaterPair>,
  play: async ({ canvasElement }) => {
    const [dark] = within(canvasElement).getAllByRole('region');
    await waitFor(() => expect(within(dark as HTMLElement).getByRole('textbox')).toBeVisible());
    await userEvent.click(within(dark as HTMLElement).getByRole('textbox'));
    await userEvent.keyboard(`${EMAIL}{Enter}`);
    await within(dark as HTMLElement).findByText('Check your email');
  },
};
