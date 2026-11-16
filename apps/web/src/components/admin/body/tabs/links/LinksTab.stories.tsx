import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { faceLoaded, must } from '@/components/kit/storyKit';
import { ThemePair } from '../../../../../../.storybook/theme';
import { LinksTabView } from './LinksTabView';
import { BODY_NOW, MASCOMA, SMALL_POND } from './linksFixtures';

/**
 * Board 5.4.9, Body › Links' inspector, at the inspector's width, dark beside light. Render one
 * beside `body-v5.html?tab=links` to compare.
 */
const meta = {
  title: 'Admin/Body/Links',
  component: LinksTabView,
  globals: { surface: 'admin', mode: 'dark' },
  args: {
    body: MASCOMA,
    now: BODY_NOW,
    canEdit: true,
    onSave: fn(async () => {}),
    lakeSheetHref: '/water/k1',
  },
  render: (args) => (
    <Inspector>
      <LinksTabView {...args} />
    </Inspector>
  ),
} satisfies Meta<typeof LinksTabView>;

export default meta;
type Story = StoryObj<typeof meta>;

function Inspector({ children }: { children: ReactNode }) {
  return (
    <ThemePair surface="admin" heading columns="lg">
      {() => <div className="w-inspector px-gutter py-(--space-5_5)">{children}</div>}
    </ThemePair>
  );
}

const quad = (canvas: HTMLElement) => must(canvas.querySelector<HTMLElement>('[data-theme-scope]'));

/** The board: three built from the lake, two added by staff with grips and Edit. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const q = quad(canvasElement);
    const chip = must(q.querySelector<HTMLElement>('[data-slot="section-chip"]'));
    const label = must(q.querySelector<HTMLElement>('[data-slot="link-row"] .text-body'));
    await faceLoaded(chip, 'BUILT FROM THE LAKE');
    await faceLoaded(label, 'Wind and weather on Windy');
    const counts = [...q.querySelectorAll('[data-slot="section-count"]')].map((c) => c.textContent);
    await expect(counts).toEqual(['3', '2']);
    await expect(q.querySelectorAll('[data-slot="sortable-grip"]')).toHaveLength(2);
    // The grip sits on the row's first line, beside the label.
    const g = must(q.querySelector('[data-slot="sortable-grip"]')).getBoundingClientRect();
    const row = must(
      q.querySelectorAll('[data-slot="sortable-row"] .text-body')[0],
    ).getBoundingClientRect();
    await expect(g.right).toBeLessThan(row.left);
  },
};

/** The keyboard path: Space lifts, ↓ moves, Space drops — each said to a reader. */
export const Reorder: Story = {
  play: async ({ canvasElement, args }) => {
    const q = within(quad(canvasElement));
    q.getByRole('button', { name: 'Move Mascoma Lake Association' }).focus();
    await userEvent.keyboard(' ');
    await waitFor(() =>
      expect(
        must(quad(canvasElement).querySelector('[data-slot="sortable-row"][data-lifted]')),
      ).toBeVisible(),
    );
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(q.getByRole('button', { name: 'Move Mascoma Lake Association' })).toHaveFocus(),
    );
    await userEvent.keyboard(' ');
    await expect(args.onSave).toHaveBeenCalledWith([
      { label: 'Lake level at Mascoma Lake Dam', url: 'https://des.nh.gov/dams' },
      { label: 'Mascoma Lake Association', url: 'https://mascomalake.org' },
    ]);
  },
};

/** A row opened by Edit: its label and address, Remove inside it. */
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await userEvent.click(must(q.getAllByRole('button', { name: 'Edit' })[0]));
    await waitFor(() => expect(q.getByRole('textbox', { name: 'Label' })).toHaveFocus());
    await expect(q.getByRole('button', { name: 'Remove' })).toBeVisible();
  },
};

/** A pond under the satellite floor: the Copernicus row rests faded, its button off. */
export const Withheld: Story = { args: { body: SMALL_POND } };

/** A viewer without the capability: no grips, no Edit, no Add. */
export const ReadOnly: Story = {
  args: { canEdit: false },
  play: async ({ canvasElement }) => {
    await expect(quad(canvasElement).querySelectorAll('[data-slot="sortable-grip"]')).toHaveLength(
      0,
    );
  },
};

/** The links as a server keeps them: each save answers after a beat, and the list echoes it. */
function Saving() {
  const [links, setLinks] = useState(MASCOMA.referenceLinks ?? []);
  return (
    <LinksTabView
      body={{ ...MASCOMA, referenceLinks: links }}
      now={BODY_NOW}
      canEdit
      lakeSheetHref="/water/k1"
      onSave={async (next) => {
        await new Promise((r) => setTimeout(r, 400));
        setLinks([...next]);
      }}
    />
  );
}

/**
 * An added link typed on while it saves: the editor is the same one, the caret where it was —
 * the keys typed after the save lands go where the moderator put them.
 */
export const AddTypedOnWhileSaving: Story = {
  render: () => (
    <Inspector>
      <Saving />
    </Inspector>
  ),
  play: async ({ canvasElement }) => {
    const q = within(quad(canvasElement));
    await userEvent.click(q.getByRole('button', { name: 'Add a link' }));
    await userEvent.type(q.getByRole('textbox', { name: 'Label' }), 'Town page');
    const url = q.getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
    await userEvent.type(url, 'https://enfield.nh.gov');
    await userEvent.click(q.getByRole('button', { name: 'Done' }));
    url.focus();
    url.setSelectionRange(8, 8);
    await userEvent.keyboard('x');
    // Settled: the add has landed (the saved link can now be removed from this editor).
    await waitFor(() => expect(q.getByRole('button', { name: 'Remove' })).toBeVisible(), {
      timeout: 3000,
    });
    const after = q.getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
    await expect(after).toBe(url);
    await expect(after).toHaveFocus();
    await expect([after.selectionStart, after.selectionEnd]).toEqual([9, 9]);
    await userEvent.keyboard('y');
    await expect(after).toHaveValue('https://xyenfield.nh.gov');
  },
};
