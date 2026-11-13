import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { SkaterPair } from '../storySupport';
import { type GooglePhotosState, GooglePhotosStatus } from './GooglePhotosCallback';
import { AUTH_PAIR } from './storyFrame';

const meta = {
  title: 'Skater/Sign-in/Google Photos pop-up',
  component: GooglePhotosStatus,
  parameters: { layout: 'fullscreen' },
  args: { state: 'opening' },
} satisfies Meta<typeof GooglePhotosStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

const STATES: GooglePhotosState[] = ['opening', 'declined', 'failed', 'signedOut'];

/**
 * 8.9 — the four states in the order a person meets them, each in a pop-up-sized window, skater dark
 * and light. Opening has the loader and nothing to press; every other state offers the one way out.
 */
export const FourStates: Story = {
  render: () => (
    <SkaterPair {...AUTH_PAIR}>
      {() => (
        <div className="grid w-full grid-cols-2 gap-6">
          {STATES.map((state) => (
            <div key={state} className="h-[15rem] overflow-hidden border border-line2 border-solid">
              <GooglePhotosStatus state={state} />
            </div>
          ))}
        </div>
      )}
    </SkaterPair>
  ),
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getAllByRole('progressbar', { name: 'Opening Google Photos' })).toHaveLength(2);
    await expect(c.getAllByRole('button', { name: 'Close this window' })).toHaveLength(6);
    await expect(c.getAllByText(/Sign in to Gli in this browser/)).toHaveLength(2);
  },
};
