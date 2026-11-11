import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { expect, fn, spyOn, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import {
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
} from './measure';
import { must } from './storyKit';
import { Tabs, TabsList, TabsTab } from './tabs';
import {
  reportTooltipInNavigation,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip';

const meta = {
  title: 'Kit/Tooltip',
  component: Tooltip,
  tags: ['autodocs'],
  // Room above the trigger for the tip.
  decorators: [(Story) => <div className="pt-[10rem]">{Story()}</div>],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

const PROMOTE_TIP = 'Lists the body for skaters and moves it to the Active lane.';

/** The open tip, wherever it was portaled (the document, or a four-up quad). */
const popup = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="tooltip-content"]');

function ActionTip({ container }: { container?: HTMLElement | null }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button aria-keyshortcuts="P" />}>Promote</TooltipTrigger>
      <TooltipContent title="Promote" container={container}>
        {PROMOTE_TIP}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * An action-bar button's tip — its main use, since a bar carries no explaining line. Hover opens
 * it: the caps title, then the words, on a square plate with no arrow.
 */
export const OnAButton: Story = {
  render: () => <ActionTip />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Promote' });
    await expect(popup()).toBeNull();
    await userEvent.hover(trigger);
    const tip = await waitFor(() => must(popup()));
    await expect(tip).toHaveTextContent(`Promote${PROMOTE_TIP}`);
    const style = getComputedStyle(tip);
    await expect(style.borderRadius).toBe('0px');
    await expect(style.backgroundColor).toEqual(
      sameColor(computedColor(tip, 'var(--plate-solid)')),
    );
    await expect(style.borderTopColor).toEqual(sameColor(computedColor(tip, 'var(--line2)')));
    await expect(tip.querySelector('[data-slot="tooltip-arrow"], svg')).toBeNull();
    const title = must(tip.querySelector('[data-slot="tooltip-title"]'));
    await expect(getComputedStyle(title).textTransform).toBe('uppercase');
    await userEvent.unhover(trigger);
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/** Keyboard focus opens it too, so the words reach a reader who never hovers. */
export const OpensOnFocus: Story = {
  render: () => <ActionTip />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Promote' });
    trigger.focus();
    await waitFor(() => expect(popup()).not.toBeNull());
    trigger.blur();
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/** What the refs below received, for the story to check. */
const refsSeen = fn();

function RefTriggers() {
  const objectRef = useRef<HTMLButtonElement | null>(null);
  const called = useRef<HTMLElement | null>(null);
  useEffect(() => refsSeen(objectRef.current, called.current));
  return (
    <div className="flex gap-(--space-2)">
      <Tooltip>
        <TooltipTrigger ref={objectRef} render={<Button />}>
          Promote
        </TooltipTrigger>
        <TooltipContent>{PROMOTE_TIP}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          ref={(el) => {
            called.current = el;
          }}
          render={<Button />}
        >
          Demote
        </TooltipTrigger>
        <TooltipContent>Moves the body back to review.</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** A trigger hands its element to a caller's ref, object or callback, past the navigation check. */
export const ForwardsRefs: Story = {
  render: () => <RefTriggers />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(refsSeen).toHaveBeenLastCalledWith(
      canvas.getByRole('button', { name: 'Promote' }),
      canvas.getByRole('button', { name: 'Demote' }),
    );
  },
};

/** Text with more on hover: the dotted rule hugs the text — a line tall, just under the baseline. */
export const TextTrigger: Story = {
  render: () => (
    <p className="text-row text-fg2">
      Merged with{' '}
      <Tooltip>
        <TooltipTrigger variant="text">+1</TooltipTrigger>
        <TooltipContent>Mascoma Lake (south bay), merged 14 Oct by Sarah</TooltipContent>
      </Tooltip>
    </p>
  ),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: '+1' });
    const style = getComputedStyle(trigger);
    await expect(style.borderBottomStyle).toBe('dotted');
    await expect(style.borderBottomColor).toEqual(sameColor(computedColor(trigger, 'var(--fg3)')));
    // The box is one 1.1 line plus the 1 px pad and the 1 px rule — the rule hugs the text.
    const size = parseFloat(style.fontSize);
    await expect(trigger.getBoundingClientRect().height).toBeCloseTo(size * 1.1 + 2, 0);
    // The plate names its own face: it portals to `body`, and the app's `body` is the legacy
    // `system-ui` (Storybook's is the kit's, which would hide an inherited face), so give `body`
    // a face the plate must not take.
    const bodyFace = document.body.style.fontFamily;
    document.body.style.fontFamily = 'serif';
    try {
      await userEvent.hover(trigger);
      const tip = await waitFor(() => must(popup()));
      await expect(getComputedStyle(tip).fontFamily).toMatch(/Saira/);
      await expect(tip.querySelector('[data-slot="tooltip-title"]')).toBeNull();
      await userEvent.unhover(trigger);
      await waitFor(() => expect(popup()).toBeNull());
    } finally {
      document.body.style.fontFamily = bodyFace;
    }
  },
};

/** Tips under one provider share a delay: moving from one to the next opens it at once. */
export const SharedDelay: Story = {
  render: () => (
    <TooltipProvider delay={600}>
      <div className="flex gap-(--space-2)">
        <Tooltip>
          <TooltipTrigger render={<Button />}>Promote</TooltipTrigger>
          <TooltipContent title="Promote">{PROMOTE_TIP}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="danger" />}>Suppress</TooltipTrigger>
          <TooltipContent title="Suppress">
            Hides the body from skaters and asks why.
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(popup()).toHaveTextContent(/^Promote/), { timeout: 2000 });
    const suppress = canvas.getByRole('button', { name: 'Suppress' });
    await userEvent.hover(suppress);
    await waitFor(() => expect(popup()).toHaveTextContent(/^Suppress/));
    await userEvent.unhover(suppress);
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/**
 * The navigation rule. A tab row is navigation, so a tooltip inside one is reported in
 * development — the console says so, and the tip still renders (it's a warning, not a crash).
 */
export const NeverInNavigation: Story = {
  render: () => (
    <Tabs defaultValue="home">
      <TabsList aria-label="Overview">
        <TabsTab value="home">Home</TabsTab>
        <Tooltip>
          <TooltipTrigger render={<TabsTab value="metrics" />}>Metrics</TooltipTrigger>
          <TooltipContent>Charts for the season</TooltipContent>
        </Tooltip>
      </TabsList>
    </Tabs>
  ),
  beforeEach: () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    return () => spy.mockRestore();
  },
  play: async ({ canvasElement }) => {
    await expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/never appear in navigation/),
      within(canvasElement).getByRole('tab', { name: 'Metrics' }),
    );
    // The check itself: navigation of every kind, and only navigation.
    const probe = (html: string) => {
      const host = document.createElement('div');
      host.innerHTML = html;
      return reportTooltipInNavigation(host.querySelector('#t'));
    };
    await expect(probe('<nav><button id="t"></button></nav>')).toBe(true);
    await expect(probe('<div role="navigation"><span id="t"></span></div>')).toBe(true);
    await expect(probe('<div role="menubar"><span id="t"></span></div>')).toBe(true);
    await expect(probe('<div role="toolbar"><button id="t"></button></div>')).toBe(false);
    await expect(reportTooltipInNavigation(null)).toBe(false);
  },
};

// ── Board, junctions and four-up ──────────────────────────────────────────────────────────────

/**
 * The tip as a board draws it, open (hover Promote): the title sits `space-1_5` over the words,
 * the plate 8 px off the trigger, and the words pass AA on the plate.
 */
export const JunctionOpen: Story = {
  render: () => <ActionTip />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Promote' });
    await userEvent.hover(trigger);
    const tip = await waitFor(() => must(popup()));
    const title = must(tip.querySelector('[data-slot="tooltip-title"]')).getBoundingClientRect();
    const body = must(tip.querySelector<HTMLElement>('[data-slot="tooltip-body"]'));
    const gap = resolvePx(tip, 'var(--space-1_5)');
    await expect(
      Math.abs(body.getBoundingClientRect().top - title.bottom - gap),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // 8 px off the trigger, on whichever side it settled (it flips when there's no room above).
    const offset = () => {
      const t = trigger.getBoundingClientRect();
      const p = tip.getBoundingClientRect();
      return tip.dataset.side === 'bottom' ? p.top - t.bottom : t.top - p.bottom;
    };
    await waitFor(() => expect(Math.abs(offset() - 8)).toBeLessThanOrEqual(1));
    await expect(tip.dataset.side).toBe('top');
    const plate = ['var(--bg)', 'var(--plate-solid)'];
    await expect(contrastBetween(tip, plate, [...plate, 'var(--fg2)'])).toBeGreaterThanOrEqual(4.5);
    await userEvent.unhover(trigger);
    await waitFor(() => expect(popup()).toBeNull());
  },
};

function QuadTip(): ReactNode {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <div ref={setContainer} className="relative pt-[10rem]">
      {container !== null && <ActionTip container={container} />}
    </div>
  );
}

/**
 * In all four maps — hover a quad's Promote and its tip is portaled into that quad, so it takes the
 * quad's theme. The check hovers each in turn.
 */
export const FourUp: Story = {
  render: () => <QuadTip />,
  parameters: { fourUp: true },
  decorators: [(Story) => Story()],
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const grounds = new Set<string>();
    for (const q of quads) {
      const trigger = within(q).getByRole('button', { name: 'Promote' });
      await userEvent.hover(trigger);
      const tip = await waitFor(() => must(popup(q)));
      grounds.add(getComputedStyle(tip).backgroundColor);
      await userEvent.unhover(trigger);
      await waitFor(() => expect(popup(q)).toBeNull());
    }
    // Dark and light plates differ.
    await expect(grounds.size).toBeGreaterThan(1);
  },
};
