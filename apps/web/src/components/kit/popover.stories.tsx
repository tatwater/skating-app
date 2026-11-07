import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { Kbd } from './kbd';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import {
  Popover,
  PopoverBody,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverFooter,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from './popover';
import { KICKER, must } from './storyKit';

const meta = {
  title: 'Kit/Popover',
  component: Popover,
  tags: ['autodocs'],
  // Room under the trigger for the plate.
  decorators: [(Story) => <div className="pb-[22rem]">{Story()}</div>],
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

const popup = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="popover-content"]');
const part = (root: Element, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));
const near = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);

/** What a motion token computes to here: zero under reduced motion. */
const motion = (ms: number) =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? '0s' : `${ms / 1000}s`;

const FACETS: ReadonlyArray<[string, readonly string[]]> = [
  ['Lane', ['Active', 'Review', 'Dormant']],
  ['Region', ['Upper Valley', 'Lakes Region', 'Seacoast']],
];

type FilterMenuProps = {
  open?: boolean;
  modal?: boolean;
  container?: HTMLElement | null;
};

/** The Filter menu: a head with the count applied, a row of options per facet, keys in the foot. */
function FilterMenu({ open, modal, container }: FilterMenuProps) {
  return (
    <Popover open={open} modal={modal}>
      <PopoverTrigger render={<Button />}>Filter</PopoverTrigger>
      <PopoverContent container={container} className="w-[22rem]">
        <PopoverHeader note="2 applied">
          <PopoverTitle>Filter</PopoverTitle>
        </PopoverHeader>
        <PopoverBody>
          {FACETS.map(([facet, options]) => (
            <div key={facet} className="flex flex-col gap-(--space-2)">
              <span className={KICKER}>{facet}</span>
              <div className="flex flex-wrap gap-(--space-1_5)">
                {options.map((o) => (
                  <Button key={o} size="xs">
                    {o}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </PopoverBody>
        <PopoverFooter>
          <Kbd variant="dim">⇥</Kbd> Next facet
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Filter menu. A square plate on the panel ground with a `line2` edge and no arrow; a lit
 * kicker title. Focus moves in and stays in (Tab cycles inside); Esc closes it and focus returns.
 */
export const FilterMenuStory: Story = {
  name: 'Filter Menu',
  render: () => <FilterMenu />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Filter' });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await expect(getComputedStyle(trigger).boxShadow).not.toBe('none');
    await userEvent.keyboard('{Enter}');
    const plate = await waitFor(() => must(popup()));
    await expect(plate).toHaveAccessibleName('Filter');

    const style = getComputedStyle(plate);
    await expect(style.borderRadius).toBe('0px');
    await expect(style.backgroundColor).toBe(computedColor(plate, 'var(--panel)'));
    await expect(style.borderTopColor).toBe(computedColor(plate, 'var(--line2)'));
    await expect(plate.querySelector('[data-slot="popover-arrow"], svg')).toBeNull();
    await expect(getComputedStyle(part(plate, 'popover-title')).textTransform).toBe('uppercase');

    // Trapped: however often Tab is pressed, focus stays on the plate.
    await waitFor(() => expect(plate.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 9; i++) {
      await userEvent.tab();
      await expect(plate.contains(document.activeElement)).toBe(true);
    }
    // The screen-reader close is out of the Tab order.
    const srClose = within(plate).getByRole('button', { name: 'Close' });
    await expect(srClose).toHaveAttribute('tabindex', '-1');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());

    // A press outside closes it too; so does the screen-reader close.
    await userEvent.click(trigger);
    await waitFor(() => expect(popup()).not.toBeNull());
    await userEvent.click(document.body);
    await waitFor(() => expect(popup()).toBeNull());
    await userEvent.click(trigger);
    await userEvent.click(within(must(popup())).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/** It fades on `duration-fast` (zero under reduced motion); nothing scales. */
export const Motion: Story = {
  render: () => <FilterMenu open />,
  play: async () => {
    const plate = await waitFor(() => must(popup()));
    const style = getComputedStyle(plate);
    await expect(style.transitionProperty).toBe('opacity');
    await expect(style.transitionDuration).toBe(motion(120));
    await expect(style.scale).toBe('none');
  },
};

const MONTHS = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];

/** The ledger's month grid: the season's months, the ones still to come inert. */
function MonthGrid() {
  return (
    <Popover open>
      <PopoverTrigger render={<Button className="w-[16rem] justify-between" />}>
        October 2026
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width)">
        <PopoverBody className="grid grid-cols-4 gap-(--space-1)">
          {MONTHS.map((m, i) => (
            <Button
              key={m}
              size="xs"
              variant={m === 'Oct' ? 'primary' : 'outline'}
              disabled={i > 4}
            >
              {m}
            </Button>
          ))}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The junctions: the plate drops 6 px under its trigger, aligned to its start edge; the body pads
 * `space-2_5` inside the edge; the head's title sits `space-3_5` in.
 */
export const JunctionOpen: Story = {
  render: () => (
    // Clear of the viewport's edge, where the plate would shift to keep its collision margin.
    <div className="p-(--space-8)">
      <MonthGrid />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const plate = await waitFor(() => must(popup()));
    const trigger = within(canvasElement).getByRole('button', { name: 'October 2026' });
    await waitFor(() => expect(getComputedStyle(plate).opacity).toBe('1'));
    const t = trigger.getBoundingClientRect();
    const p = plate.getBoundingClientRect();
    await near(p.top - t.bottom, 6);
    await near(p.left, t.left);
    await near(p.width, t.width);
    const edge = resolvePx(plate, 'var(--stroke-hair)');
    const first = must(part(plate, 'popover-body').firstElementChild).getBoundingClientRect();
    await near(first.left - p.left - edge, resolvePx(plate, 'var(--space-2_5)'));
    await near(first.top - p.top - edge, resolvePx(plate, 'var(--space-2_5)'));
  },
};

/** The head's title one `space-3_5` in from the edge, the note at the right; the foot ruled above. */
export const HeadAndFoot: Story = {
  render: () => <FilterMenu open />,
  play: async () => {
    const plate = await waitFor(() => must(popup()));
    const p = plate.getBoundingClientRect();
    const edge = resolvePx(plate, 'var(--stroke-hair)');
    const title = part(plate, 'popover-title').getBoundingClientRect();
    await near(title.left - p.left - edge, resolvePx(plate, 'var(--space-3_5)'));
    const note = part(plate, 'popover-note').getBoundingClientRect();
    await near(p.right - edge - note.right, resolvePx(plate, 'var(--space-3_5)'));
    const foot = part(plate, 'popover-footer');
    await expect(getComputedStyle(foot).borderTopColor).toBe(computedColor(foot, 'var(--line)'));
    await near(foot.getBoundingClientRect().bottom, p.bottom - edge);
  },
};

/** Too long for the viewport: the plate stops at the available height and its body scrolls. */
export const LongList: Story = {
  render: () => (
    <Popover open>
      <PopoverTrigger render={<Button />}>Bodies</PopoverTrigger>
      <PopoverContent className="w-[20rem]">
        <PopoverHeader>
          <PopoverTitle>Recent</PopoverTitle>
        </PopoverHeader>
        <PopoverBody>
          {Array.from({ length: 80 }, (_, i) => `Mascoma Lake ${i + 1}`).map((name) => (
            <span key={name}>{name}</span>
          ))}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  ),
  play: async () => {
    const plate = await waitFor(() => must(popup()));
    const body = part(plate, 'popover-body');
    await expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    await expect(plate.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      document.documentElement.clientHeight,
    );
  },
};

/**
 * A head with words under the title, and a way out of its own: `PopoverClose` on a kit Button
 * closes it like Esc does.
 */
export const WithDescription: Story = {
  render: () => (
    <Popover>
      <PopoverTrigger render={<Button />}>Columns</PopoverTrigger>
      <PopoverContent className="w-[18rem]">
        <PopoverHeader className="flex-col items-start gap-(--space-1_5)">
          <PopoverTitle>Columns</PopoverTitle>
          <PopoverDescription>Shown in this order in the list.</PopoverDescription>
        </PopoverHeader>
        <PopoverFooter>
          <PopoverClose render={<Button size="xs" className="ml-auto" />}>Done</PopoverClose>
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Columns' }));
    const plate = await waitFor(() => must(popup()));
    await expect(plate).toHaveAccessibleDescription('Shown in this order in the list.');
    const title = part(plate, 'popover-title').getBoundingClientRect();
    const words = part(plate, 'popover-description').getBoundingClientRect();
    await near(words.top - title.bottom, resolvePx(plate, 'var(--space-1_5)'));
    await userEvent.click(within(plate).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(popup()).toBeNull());
  },
};

function QuadMenu(): ReactNode {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  return (
    <div ref={setFrame} className="relative pb-[16rem]">
      {frame !== null && <FilterMenu open modal={false} container={frame} />}
    </div>
  );
}

/**
 * Open in all four maps, each portaled into its quad (non-modal here: four focus traps at once
 * would fight). The console's kicker is the smaller step, and each plate takes its quad's ground.
 */
export const FourUp: Story = {
  render: () => <QuadMenu />,
  parameters: { fourUp: true },
  decorators: [(Story) => Story()],
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const seen: Array<{ surface?: string; type: number; ground: string }> = [];
    for (const q of quads) {
      const plate = await waitFor(() => must(popup(q)));
      seen.push({
        surface: q.dataset.surface,
        type: parseFloat(getComputedStyle(part(plate, 'popover-title')).fontSize),
        ground: getComputedStyle(plate).backgroundColor,
      });
    }
    const admin = seen.filter((s) => s.surface === 'admin').map((s) => s.type);
    const skater = seen.filter((s) => s.surface === 'skater').map((s) => s.type);
    await expect(Math.max(...admin)).toBeLessThan(Math.min(...skater));
    await expect(new Set(seen.map((s) => s.ground)).size).toBeGreaterThan(1);
  },
};
