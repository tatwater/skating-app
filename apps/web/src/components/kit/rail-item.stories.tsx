import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faCabinetFiling,
  faCalendarDays,
  faEngine,
  faInbox,
  faMapLocationDot,
  faMessageLines,
  faSliders,
  faTachographDigital,
  faUsers,
} from '@fortawesome/sharp-light-svg-icons';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import {
  computedColor,
  contrastBetween,
  JUNCTION_TOLERANCE_PX,
  resolvePx,
  sameColor,
  sameShadow,
} from './measure';
import { RailItem, RailViewer } from './rail-item';
import { must, PSEUDO_STATES, StateMatrix } from './storyKit';

const meta = {
  title: 'Kit/Rail item',
  component: RailItem,
  tags: ['autodocs'],
  args: { icon: <FontAwesomeIcon icon={faInbox} />, name: 'Inbox', href: '#inbox' },
  globals: { surface: 'admin' },
  render: (args) => (
    <InNav>
      <RailItem {...args} />
    </InNav>
  ),
  parameters: {
    docs: {
      description: {
        component:
          'Admin only. The console rail’s mode link: a 20 px icon over an 8 px caps name, the count in a square mono badge pinned to the corner (gray, amber, red), the current mode lit with a white edge bar and its glow. Go-mode hides the count behind the go chip. The app item opens a new tab. Navigation never carries a tooltip. Routing is a `render` slot — the stories pass a plain `<a>`.',
      },
    },
  },
} satisfies Meta<typeof RailItem>;

export default meta;
type Story = StoryObj<typeof meta>;

const MODES = [
  { key: 'O', name: 'Overview', icon: faTachographDigital },
  { key: 'I', name: 'Inbox', icon: faInbox, count: 19, tone: 'warn' as const },
  { key: 'R', name: 'Reports', icon: faMessageLines },
  { key: 'C', name: 'Corpus', icon: faCabinetFiling, count: '1.2k' },
  { key: 'B', name: 'Bodies', icon: faMapLocationDot },
  { key: 'M', name: 'Machinery', icon: faEngine, count: 1, tone: 'bad' as const },
  { key: 'S', name: 'Seasons', icon: faCalendarDays },
  { key: 'P', name: 'People', icon: faUsers, count: 1 },
  { key: 'T', name: 'Tuning', icon: faSliders },
];

/** The rail's column, as the shell draws it: a nav one rail wide, ruled on its right. */
function InNav({ children, label = 'Modes' }: { children: ReactNode; label?: string }) {
  return (
    <nav aria-label={label} className="flex w-rail flex-col border-r border-solid border-line">
      {children}
    </nav>
  );
}

/** The whole rail as the boards draw it: nine modes, the app, the viewer. */
function Rail({ current = 'Inbox', go = false }: { current?: string; go?: boolean }) {
  return (
    <>
      {MODES.map((m) => (
        <RailItem
          key={m.name}
          href={`#${m.name.toLowerCase()}`}
          icon={<FontAwesomeIcon icon={m.icon} />}
          name={m.name}
          current={m.name === current}
          go={go}
          goKey={m.key}
          {...(m.count !== undefined ? { count: m.count } : {})}
          {...(m.tone !== undefined ? { countTone: m.tone } : {})}
        />
      ))}
      <div className="h-(--space-8)" />
      <RailItem
        variant="app"
        href="https://example.com/app"
        icon={<FontAwesomeIcon icon={faArrowUpRightFromSquare} />}
        name="App"
        go={go}
        goKey="A"
      />
      <RailViewer name="Teagan Atwater" className="mb-(--space-2_5)" />
    </>
  );
}

const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('nav a')];
const part = (root: ParentNode, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));

/** The rail on Inbox: the current mode lit, three counts in their three tones. */
export const Rail_: Story = {
  name: 'Rail',
  render: () => (
    <InNav>
      <Rail />
    </InNav>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inbox = canvas.getByRole('link', { name: /Inbox/ });
    await expect(inbox).toHaveAttribute('aria-current', 'page');
    await expect(
      canvas.getAllByRole('link').filter((l) => l.hasAttribute('aria-current')),
    ).toHaveLength(1);
    await expect(getComputedStyle(inbox).color).toEqual(
      sameColor(computedColor(inbox, 'var(--fg)')),
    );
    const overview = canvas.getByRole('link', { name: 'Overview' });
    await expect(getComputedStyle(overview).color).toEqual(
      sameColor(computedColor(overview, 'var(--fg3)')),
    );
    // No count, no badge — never a 0.
    await expect(overview.querySelector('[data-slot="rail-count"]')).toBeNull();
    // The three tones.
    const fill = (name: RegExp) =>
      getComputedStyle(part(canvas.getByRole('link', { name }), 'rail-count')).backgroundColor;
    await expect(fill(/Inbox/)).toEqual(sameColor(computedColor(inbox, 'var(--warn)')));
    await expect(fill(/Machinery/)).toEqual(sameColor(computedColor(inbox, 'var(--bad)')));
    await expect(fill(/Corpus/)).toEqual(sameColor(computedColor(inbox, 'var(--fg2)')));
    // Navigation carries no tooltips: nothing in the rail is a tooltip trigger or has a title.
    const nav = canvas.getByRole('navigation');
    await expect(nav.querySelector('[data-slot="tooltip-trigger"], [title]')).toBeNull();
    // The app opens in a new tab, and says so.
    const app = canvas.getByRole('link', { name: /App/ });
    await expect(app).toHaveAttribute('target', '_blank');
    await expect(app).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(app).toHaveAccessibleName('App (opens in a new tab)');
    await expect(app).not.toHaveAttribute('aria-current');
    // The viewer is a circle, named for the person.
    const viewer = canvas.getByRole('img', { name: 'Teagan Atwater' });
    await expect(getComputedStyle(viewer).borderRadius).not.toBe('0px');
    await expect(viewer.getBoundingClientRect().width).toBeCloseTo(
      resolvePx(viewer, 'var(--size-avatar-lg)'),
      1,
    );
  },
};

/** A count can speak for itself: the badge is decoration, the reader hears the label. */
export const CountLabel: Story = {
  args: { count: 19, countTone: 'warn', countLabel: '19 waiting on a person' },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link');
    await expect(link).toHaveAccessibleName('Inbox 19 waiting on a person');
    await expect(part(link, 'rail-count')).toHaveAttribute('aria-hidden', 'true');
  },
};

/** The routing slot: whatever element the router hands over renders the item. */
export const LinkSlot: Story = {
  args: {
    current: true,
    count: 3,
    // A router's link would go here; the story uses a plain anchor marked as one.
    // biome-ignore lint/a11y/useAnchorContent: the rail item renders its icon and name into it.
    render: <a href="#routed" data-router-link="" />,
  },
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: /Inbox/ });
    await expect(link).toHaveAttribute('data-router-link');
    await expect(link).toHaveAttribute('href', '#routed');
    await expect(link).toHaveAttribute('aria-current', 'page');
    await expect(link.querySelector('[data-slot="rail-icon"]')).not.toBeNull();
  },
};

/** Go-mode: the counts give way to the go chips; the current mode stays full bright. */
export const GoMode: Story = {
  render: () => (
    <InNav>
      <Rail current="Inbox" go />
    </InNav>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inbox = canvas.getByRole('link', { name: /Inbox/ });
    const reports = canvas.getByRole('link', { name: /Reports/ });
    await expect(getComputedStyle(part(inbox, 'rail-count')).visibility).toBe('hidden');
    await expect(getComputedStyle(inbox).color).toEqual(
      sameColor(computedColor(inbox, 'var(--fg)')),
    );
    await expect(getComputedStyle(reports).color).toEqual(
      sameColor(computedColor(reports, 'var(--fg2)')),
    );
    const chip = part(reports, 'rail-go');
    await expect(chip).toHaveAttribute('data-variant', 'go');
    await expect(chip).toHaveTextContent('GR');
    await expect(part(chip, 'kbd-spent')).toHaveTextContent('G');
    // The chip is decoration: the link's name stays the mode's.
    await expect(reports).toHaveAccessibleName('Reports');
    await expect(part(canvas.getByRole('link', { name: /App/ }), 'rail-go')).toHaveTextContent(
      'GA',
    );
  },
};

/** Keyboard focus lights the item as hover does, with a ring drawn inside it. */
export const FocusLights: Story = {
  render: () => (
    <InNav>
      <Rail />
    </InNav>
  ),
  play: async ({ canvasElement }) => {
    const overview = within(canvasElement).getByRole('link', { name: 'Overview' });
    await userEvent.tab();
    await expect(overview).toHaveFocus();
    const lit = computedColor(overview, 'var(--fg1)');
    await waitFor(() => expect(getComputedStyle(overview).color).toEqual(sameColor(lit)));
    // An inset ring: it never spills over the neighbors.
    await waitFor(() =>
      expect(getComputedStyle(overview).boxShadow).toEqual(
        sameShadow({ lengths: [0, 0, 0, 1], inset: true }),
      ),
    );
  },
};

// ── Junctions ────────────────────────────────────────────────────────────────────────────────

/**
 * Admin: the item is the rail-item step tall (52 px); the name sits 5 px under the icon and centers
 * on it; the badge is 12 × ≥14, 6 px down and 4 px in; the on bar is 2 × 24, centered on the edge.
 */
export const JunctionAdmin: Story = {
  render: () => (
    <InNav>
      <Rail />
    </InNav>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const px = (len: string) => resolvePx(canvasElement, len);
    const near = (a: number, b: number) => Math.abs(a - b) <= JUNCTION_TOLERANCE_PX;
    const inbox = canvas.getByRole('link', { name: /Inbox/ });
    const box = inbox.getBoundingClientRect();
    await expect(box.height).toBeCloseTo(px('var(--size-rail-item)'), 1);
    await expect(box.height).toBeCloseTo(px('3.25rem'), 1);

    const icon = part(inbox, 'rail-icon').getBoundingClientRect();
    const name = part(inbox, 'rail-name');
    const nameBox = name.getBoundingClientRect();
    await expect(icon.width).toBeCloseTo(px('1.25rem'), 1);
    await expect(near(nameBox.top - icon.bottom, px('0.3125rem'))).toBe(true);
    // The name is the 8 px rail step, the sub-floor exception.
    await expect(getComputedStyle(name).fontSize).toBe(`${px('var(--type-rail)')}px`);
    await expect(getComputedStyle(name).textTransform).toBe('uppercase');
    // Its ink centers on the icon: the trailing tracking is given back on the left.
    const range = document.createRange();
    range.selectNodeContents(name);
    const ink = range.getBoundingClientRect();
    const tracking = parseFloat(getComputedStyle(name).letterSpacing);
    const inkMid = (ink.left + ink.right - tracking) / 2;
    await expect(Math.abs(inkMid - (icon.left + icon.right) / 2)).toBeLessThanOrEqual(0.75);
    // The icon-and-name stack centers in the item.
    await expect(near(icon.top - box.top, box.bottom - nameBox.bottom)).toBe(true);

    const badge = part(inbox, 'rail-count');
    const b = badge.getBoundingClientRect();
    await expect(b.height).toBeCloseTo(px('0.75rem'), 1);
    await expect(b.width).toBeGreaterThanOrEqual(px('0.875rem') - JUNCTION_TOLERANCE_PX);
    await expect(near(b.top - box.top, px('var(--space-1_5)'))).toBe(true);
    await expect(near(box.right - b.right, px('var(--space-1)'))).toBe(true);
    await expect(getComputedStyle(badge).borderRadius).toBe('0px');
    await expect(getComputedStyle(badge).fontFamily).toMatch(/Martian Mono/);
    // Every badge shares one right edge.
    const rights = [/Corpus/, /Machinery/, /People/].map(
      (n) =>
        part(canvas.getByRole('link', { name: n }), 'rail-count').getBoundingClientRect().right,
    );
    for (const r of rights) await expect(near(r, b.right)).toBe(true);

    const bar = getComputedStyle(inbox, '::before');
    await expect(bar.width).toBe('2px');
    await expect(parseFloat(bar.height)).toBeCloseTo(px('1.5rem'), 1);
    await expect(bar.left).toBe('0px');
    await expect(bar.backgroundColor).toEqual(sameColor(computedColor(inbox, 'var(--fg)')));
    await expect(bar.boxShadow).toEqual(sameShadow([0, 0, 8, 0]));
    // A resting item draws no bar.
    await expect(
      getComputedStyle(canvas.getByRole('link', { name: 'Reports' }), '::before').content,
    ).toBe('none');

    // The app item: 46 px, a hairline 6 px over it, 18 px in from each side.
    const app = canvas.getByRole('link', { name: /App/ });
    await expect(app.getBoundingClientRect().height).toBeCloseTo(px('2.875rem'), 1);
    const rule = getComputedStyle(app, '::after');
    await expect(rule.height).toBe('1px');
    await expect(parseFloat(rule.top)).toBeCloseTo(-px('var(--space-1_5)'), 1);
    await expect(parseFloat(rule.left)).toBeCloseTo(px('var(--space-4_5)'), 1);
    await expect(part(app, 'rail-icon').getBoundingClientRect().width).toBeCloseTo(
      px('0.9375rem'),
      1,
    );
  },
};

/** Every count's digits pass AA on its fill, in the theme on screen. */
export const CountContrast: Story = {
  render: () => (
    <InNav>
      <Rail />
    </InNav>
  ),
  play: async ({ canvasElement }) => {
    for (const badge of canvasElement.querySelectorAll<HTMLElement>('[data-slot="rail-count"]')) {
      const style = getComputedStyle(badge);
      const ratio = contrastBetween(badge, [style.backgroundColor], [style.color]);
      await expect(ratio, badge.dataset.tone).toBeGreaterThanOrEqual(4.5);
    }
  },
};

// ── Matrix and four-up ───────────────────────────────────────────────────────────────────────

const ROWS = [
  { key: 'mode', label: 'Mode' },
  { key: 'current', label: 'On' },
  { key: 'go', label: 'Go-mode' },
  { key: 'app', label: 'App' },
] as const;
const STATES = [
  { key: 'rest', label: 'Rest' },
  { key: 'hover', label: 'Hover' },
  { key: 'focus', label: 'Focus' },
] as const;

/** Each kind of item at rest, hovered and focused (hover and focus are one look). */
export const States: Story = {
  render: () => (
    <StateMatrix
      rows={ROWS}
      states={STATES}
      cell={(row, state) => (
        <InNav label={`${row} ${state}`}>
          {row === 'app' ? (
            <RailItem
              variant="app"
              href="#app"
              data-state={state}
              icon={<FontAwesomeIcon icon={faArrowUpRightFromSquare} />}
              name="App"
            />
          ) : (
            <RailItem
              href="#inbox"
              data-state={state}
              icon={<FontAwesomeIcon icon={faInbox} />}
              name="Inbox"
              count={19}
              countTone="warn"
              current={row === 'current'}
              go={row === 'go'}
              goKey="I"
            />
          )}
        </InNav>
      )}
    />
  ),
  parameters: PSEUDO_STATES,
  play: async ({ canvasElement }) => {
    // The resting name passes AA... the 8 px rail step is a floor exception, so it's held to AA.
    for (const item of items(canvasElement)) {
      const ratio = contrastBetween(item, ['var(--bg)'], [getComputedStyle(item).color]);
      await expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  },
};

/** The rail in all four maps. Admin only: the skater quads show the same item, unused there. */
export const FourUp: Story = {
  render: () => (
    <InNav>
      <Rail />
    </InNav>
  ),
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const inbox = within(q).getByRole('link', { name: /Inbox/ });
      await expect(inbox.getBoundingClientRect().height).toBeCloseTo(
        resolvePx(q, 'var(--size-rail-item)'),
        1,
      );
      const badge = part(inbox, 'rail-count');
      const style = getComputedStyle(badge);
      await expect(
        contrastBetween(badge, [style.backgroundColor], [style.color]),
      ).toBeGreaterThanOrEqual(4.5);
    }
  },
};
