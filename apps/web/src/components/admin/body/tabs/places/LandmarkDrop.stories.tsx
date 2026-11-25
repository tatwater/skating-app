import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { LandmarkDrop, type LandmarkDropProps } from './LandmarkDrop';
import { type LandmarkDraft, startLandmarkDraft, withPoint } from './landmarkDraft';

/**
 * Board 5.4.3 | Places | Drop a Landmark (B01-6b), dark beside light, at the inspector's width: the
 * card a drop opens over the list — a moderator's own drop with the point placed, an emailed name
 * arriving filled with nothing placed yet, and a skater's proposal arriving at the skater's point.
 * The board's *Within 1 km* block and the bay the point falls in are left for later.
 */
const meta = {
  title: 'Admin/Body/Places/Drop a landmark',
  component: LandmarkDrop,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    draft: withPoint(startLandmarkDraft({ kind: 'new' }), { lat: 43.64536, lng: -72.16689 }),
    saving: false,
    onName: fn(),
    onAliases: fn(),
    onKind: fn(),
    onSave: fn(),
    onDiscard: fn(),
  },
  render: (args) => (
    <ThemePair surface="admin" heading columns="lg">
      {() => (
        <div className="relative h-[40rem] w-inspector px-gutter py-(--space-5_5)">
          <Controlled {...args} />
        </div>
      )}
    </ThemePair>
  ),
} satisfies Meta<typeof LandmarkDrop>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The tab holds the draft; a story keeps it in state, so typing and picking show. */
function Controlled(args: LandmarkDropProps) {
  const [draft, setDraft] = useState<LandmarkDraft>(args.draft);
  return (
    <LandmarkDrop
      {...args}
      draft={draft}
      onName={(name) => {
        setDraft((d) => ({ ...d, name }));
        args.onName(name);
      }}
      onAliases={(aliases) => {
        setDraft((d) => ({ ...d, aliases }));
        args.onAliases(aliases);
      }}
      onKind={(kind) => {
        setDraft((d) => ({ ...d, kind }));
        args.onKind(kind);
      }}
    />
  );
}

const quad = (canvas: HTMLElement) => must(canvas.querySelector<HTMLElement>('[data-theme-scope]'));

/** A moderator's own drop: the point placed; a name and a kind, then ⏎, add it. */
export const NewLandmark: Story = {
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('A new landmark')).toBeVisible();
    await expect(q.getByText('43.6454, −72.1669')).toBeVisible();
    const add = q.getByRole('button', { name: /Add to the map/ });
    await expect(add).toBeDisabled();
    await expect(q.getByText('It needs a name')).toBeVisible();
    await userEvent.type(q.getByRole('textbox', { name: 'Name' }), 'Shaker cove');
    await expect(q.getByText('Choose what kind of place it is')).toBeVisible();
    await userEvent.click(q.getByRole('combobox', { name: 'Kind' }));
    await userEvent.click(await within(document.body).findByRole('option', { name: 'Bay' }));
    await expect(args.onKind).toHaveBeenCalledWith('bay');
    await expect(add).toBeEnabled();
    await userEvent.type(q.getByRole('textbox', { name: 'Name' }), '{Enter}');
    await expect(args.onSave).toHaveBeenCalledTimes(1);
  },
};

/** An emailed name: filled, its note saying what the save does, waiting for its point. */
export const AnEmailedName: Story = {
  args: {
    draft: startLandmarkDraft(
      { kind: 'place-name', corpusNameId: 'n1', messages: 12 },
      { name: 'the Narrows', aliases: ['The Narrows'] },
    ),
  },
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('A name from the emails')).toBeVisible();
    await expect(q.getByText(/12 emails use it/)).toBeVisible();
    await expect(q.getByRole('textbox', { name: 'Name' })).toHaveValue('the Narrows');
    await expect(q.getByText('Not placed yet')).toBeVisible();
  },
};

/** A skater's proposal: placed where they put it, Back leaves without saving. */
export const AProposal: Story = {
  args: {
    draft: startLandmarkDraft(
      { kind: 'proposal', requestId: 'r1', askers: 3 },
      { name: 'Bird Poop Rock', point: { lat: 43.6468, lng: -72.1787 } },
    ),
  },
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    await expect(q.getByText('A skater’s proposal')).toBeVisible();
    await expect(q.getByText(/answers all 3 skaters who asked/)).toBeVisible();
    await expect(q.getByText('43.6468, −72.1787')).toBeVisible();
    await userEvent.click(q.getByRole('button', { name: /Back to landmarks/ }));
    await expect(args.onDiscard).toHaveBeenCalledTimes(1);
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};
