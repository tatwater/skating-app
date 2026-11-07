import { tokens } from '@skating/design';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { Kbd } from './kbd';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { LockBanner, Note } from './note';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Note',
  component: Note,
  tags: ['autodocs'],
  args: { children: 'The older outline is kept in History.' },
  decorators: [(Story) => <div className="w-full max-w-[26rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'A note is a **2 px rule down the left, no fill**: gray to know, amber when it waits on a person, red only when it won’t recover without one — **never red at rest**. The lock banner is the colleague lock over a record: *held* while someone else has it open, *decided* when it was decided while it was open here.',
      },
    },
  },
} satisfies Meta<typeof Note>;

export default meta;
type Story = StoryObj<typeof meta>;

const part = (root: ParentNode, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));

/** Within a quarter pixel. */
async function near(actual: number, want: number, what: string) {
  await expect(Math.abs(actual - want), what).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
}

// ── Notes ────────────────────────────────────────────────────────────────────────────────────

/**
 * The gray note: a 2 px rule, no fill, no box. The text is trimmed, so the rule runs `space-1_5`
 * past the caps and the baseline, and sits `space-3` from the ink.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const note = within(canvasElement).getByRole('note');
    await expect(note).toHaveAttribute('data-tone', 'default');
    const s = getComputedStyle(note);
    await expect(s.borderLeftWidth).toBe('2px');
    await expect(s.borderLeftStyle).toBe('solid');
    await expect(s.borderLeftColor).toBe(computedColor(note, 'var(--fg3)'));
    for (const side of ['Top', 'Right', 'Bottom'] as const) {
      await expect(s[`border${side}Width`]).toBe('0px');
    }
    await expect(s.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    await expect(s.color).toBe(computedColor(note, 'var(--fg2)'));
    // Rule → ink.
    const text = document.createRange();
    text.selectNodeContents(note);
    const ink = text.getBoundingClientRect();
    const box = note.getBoundingClientRect();
    await near(ink.left - (box.left + 2), resolvePx(note, 'var(--space-3)'), 'rule → text');
    // One trimmed line: the rule is a cap height plus `space-1_5` above and below.
    const pad = resolvePx(note, 'var(--space-1_5)');
    await near(box.height, resolvePx(note, '1cap') + 2 * pad, 'rule height');
  },
};

/** Amber: it waits on a person. */
export const Warn: Story = {
  args: {
    tone: 'warn',
    children: (
      <>
        <strong>Bathymetry is missing.</strong> Ask a source or mark it unknown.
      </>
    ),
  },
  play: async ({ canvasElement }) => {
    const note = within(canvasElement).getByRole('note');
    await expect(getComputedStyle(note).borderLeftColor).toBe(computedColor(note, 'var(--warn)'));
    // Emphasis is the lit ink, medium — the text stays gray.
    const strong = must(note.querySelector('strong'));
    await expect(getComputedStyle(strong).color).toBe(computedColor(strong, 'var(--fg)'));
    await expect(getComputedStyle(strong).fontWeight).toBe(String(tokens.fontWeight.medium));
    await expect(getComputedStyle(note).color).toBe(computedColor(note, 'var(--fg2)'));
  },
};

/** Red, by meaning only: it won't recover without a person. */
export const Bad: Story = {
  args: { tone: 'bad', children: 'The import stopped at batch 9 of 21. Nothing after it ran.' },
  play: async ({ canvasElement }) => {
    const note = within(canvasElement).getByRole('note');
    await expect(getComputedStyle(note).borderLeftColor).toBe(computedColor(note, 'var(--bad)'));
  },
};

/** Never red at rest: a note with no tone is gray, whatever it says. */
export const NeverRedAtRest: Story = {
  args: { children: 'Two reports disagree about the east shore.' },
  play: async ({ canvasElement }) => {
    const note = within(canvasElement).getByRole('note');
    await expect(getComputedStyle(note).borderLeftColor).not.toBe(
      computedColor(note, 'var(--bad)'),
    );
    await expect(getComputedStyle(note).borderLeftColor).not.toBe(
      computedColor(note, 'var(--warn)'),
    );
  },
};

/** A long note wraps; the rule runs its full height, and the trim cuts only the outer lines. */
export const Wrapping: Story = {
  args: {
    children:
      'The bay was redrawn on the west shore after the survey. The older outline is kept in History, and the reports filed against it stay attached to the bay.',
  },
  decorators: [(Story) => <div className="w-[16rem]">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const note = within(canvasElement).getByRole('note');
    const line = resolvePx(note, '1lh');
    const pad = resolvePx(note, 'var(--space-1_5)');
    const h = note.getBoundingClientRect().height - 2 * pad;
    // n lines trimmed: (n − 1) line boxes plus one cap height.
    const n = Math.round((h - resolvePx(note, '1cap')) / line) + 1;
    await expect(n).toBeGreaterThan(1);
    await near(h, (n - 1) * line + resolvePx(note, '1cap'), 'trimmed height');
  },
};

// ── The lock banner ──────────────────────────────────────────────────────────────────────────

function Held() {
  return (
    <LockBanner
      state="held"
      actions={
        <Button size="xs" variant="outline">
          Take over
        </Button>
      }
    >
      <strong>Sarah</strong> has this open · 2 min
    </LockBanner>
  );
}

function DecidedActions() {
  return (
    <>
      <Button size="xs" variant="link">
        History
      </Button>
      <Button size="xs" variant="primary" aria-keyshortcuts="Shift+Enter">
        Back to the queue
        <Kbd aria-hidden="true">⇧⏎</Kbd>
      </Button>
    </>
  );
}

function Decided() {
  return (
    <LockBanner state="decided" actions={<DecidedActions />}>
      <strong>Decided by Sarah</strong> · 14:42 · approved, the bay drawn
    </LockBanner>
  );
}

/**
 * Held: a colleague has it open. A hairline box on the panel ground, the line left, *Take over*
 * right; the button is the row's tallest content, so it sits exactly the inset from the border.
 */
export const LockHeld: Story = {
  render: () => <Held />,
  play: async ({ canvasElement }) => {
    const banner = part(canvasElement, 'lock-banner');
    await expect(banner).not.toHaveAttribute('role');
    const s = getComputedStyle(banner);
    await expect(s.borderTopWidth).toBe('1px');
    await expect(s.borderTopColor).toBe(computedColor(banner, 'var(--line2)'));
    await expect(s.backgroundColor).toBe(computedColor(banner, 'var(--panel)'));
    await expect(s.borderRadius).toBe('0px');
    const box = banner.getBoundingClientRect();
    const button = within(banner)
      .getByRole('button', { name: 'Take over' })
      .getBoundingClientRect();
    const inset = resolvePx(banner, 'var(--space-2_5)');
    await near(button.top - (box.top + 1), inset, 'border → button');
    await near(box.bottom - 1 - button.bottom, inset, 'button → border');
    await near(box.right - 1 - button.right, resolvePx(banner, 'var(--space-3_5)'), 'right inset');
    // The line centers on the button: one row.
    const line = part(banner, 'lock-banner-line').getBoundingClientRect();
    const mid = (r: DOMRect) => r.top + r.height / 2;
    await expect(Math.abs(mid(line) - mid(button))).toBeLessThanOrEqual(0.5);
  },
};

/**
 * Decided while it was open here: the hairline brightens, the line takes the whole row, and the
 * way on sits under it — `space-2_5` from the line's baseline to the buttons, ink to box. It is
 * announced politely.
 */
export const LockDecided: Story = {
  render: () => <Decided />,
  play: async ({ canvasElement }) => {
    const banner = within(canvasElement).getByRole('status');
    await expect(banner).toHaveAttribute('data-state', 'decided');
    await expect(getComputedStyle(banner).borderTopColor).toBe(computedColor(banner, 'var(--fg2)'));
    const box = banner.getBoundingClientRect();
    const line = part(banner, 'lock-banner-line').getBoundingClientRect();
    const actions = part(banner, 'lock-banner-actions').getBoundingClientRect();
    const inset = resolvePx(banner, 'var(--space-2_5)');
    // The line spans the row's content width; the actions start on its left edge, under it.
    await near(line.width, box.width - 2 - 2 * resolvePx(banner, 'var(--space-3_5)'), 'line width');
    await near(actions.left, line.left, 'actions left');
    // Junctions, top to bottom: border → ink, ink → buttons, buttons → border.
    await near(line.top - (box.top + 1), inset, 'border → line');
    await near(actions.top - line.bottom, inset, 'line → actions');
    await near(box.bottom - 1 - actions.bottom, inset, 'actions → border');
    // The way back to the queue carries its key.
    const back = within(banner).getByRole('button', { name: /Back to the queue/ });
    await expect(back).toHaveAttribute('aria-keyshortcuts', 'Shift+Enter');
  },
};

function Flips() {
  const [state, setState] = useState<'held' | 'decided'>('held');
  return (
    <div className="flex flex-col gap-heading">
      <button type="button" onClick={() => setState('decided')}>
        Decide elsewhere
      </button>
      <LockBanner
        state={state}
        actions={state === 'held' ? <Button size="xs">Take over</Button> : <DecidedActions />}
      >
        {state === 'held' ? (
          <>
            <strong>Sarah</strong> has this open · 2 min
          </>
        ) : (
          <>
            <strong>Decided by Sarah</strong> · 14:42 · approved, the bay drawn
          </>
        )}
      </LockBanner>
    </div>
  );
}

/**
 * The flip: held turns to decided in place. The banner keeps its top edge, becomes a polite live
 * region, and its border changes on the base motion token (zero under reduced motion).
 */
export const DecidedWhileYouLooked: Story = {
  render: () => <Flips />,
  play: async ({ canvasElement }) => {
    const banner = part(canvasElement, 'lock-banner');
    const top = banner.getBoundingClientRect().top;
    await expect(parseFloat(getComputedStyle(banner).transitionDuration) * 1000).toBe(
      tokens.duration.base,
    );
    await expect(getComputedStyle(banner).transitionProperty).toBe('border-color');
    const lit = computedColor(banner, 'var(--fg2)');
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Decide elsewhere' }));
    await expect(within(canvasElement).getByRole('status')).toBe(banner);
    await waitFor(() => expect(getComputedStyle(banner).borderTopColor).toBe(lit));
    await expect(banner.getBoundingClientRect().top).toBe(top);
  },
};

// ── Board and four-up ────────────────────────────────────────────────────────────────────────

function Board() {
  return (
    <div className="flex w-full max-w-[26rem] flex-col gap-(--space-6)">
      <div className="flex flex-col gap-heading">
        <span className={KICKER}>Notes</span>
        <Note>The older outline is kept in History.</Note>
        <Note tone="warn">
          <strong>Bathymetry is missing.</strong> Ask a source or mark it unknown.
        </Note>
        <Note tone="bad">The import stopped at batch 9 of 21.</Note>
      </div>
      <div className="flex flex-col gap-heading">
        <span className={KICKER}>Lock banner</span>
        <Held />
        <Decided />
      </div>
    </div>
  );
}

/** Every tone and both banners in all four maps: the rule reads on every ground. */
export const FourUp: Story = {
  render: () => <Board />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const notes = within(q).getAllByRole('note');
      await expect(notes).toHaveLength(3);
      for (const n of notes) {
        await expect(getComputedStyle(n).borderLeftWidth).toBe('2px');
        await expect(getComputedStyle(n).backgroundColor).toBe('rgba(0, 0, 0, 0)');
      }
      await expect(within(q).getAllByRole('status')).toHaveLength(1);
    }
  },
};
