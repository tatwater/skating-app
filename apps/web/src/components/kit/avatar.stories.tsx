import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';

import { Avatar, AvatarStack, initialsOf, StackFace } from './avatar';
import { computedColor, horizontalGaps, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { KICKER, must, rootPx } from './storyKit';

const meta = {
  title: 'Kit/Avatar',
  component: Avatar,
  tags: ['autodocs'],
  args: { name: 'Sarah Kim' },
  argTypes: {
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    tone: { control: 'inline-radio', options: ['default', 'viewer'] },
  },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A photo as a data URI, so the story never reaches the network: a gray field, a lighter head. */
const PHOTO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#4a4a4a"/><circle cx="20" cy="16" r="7" fill="#9a9a9a"/><rect x="8" y="26" width="24" height="14" rx="7" fill="#9a9a9a"/></svg>',
)}`;

const avatars = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="avatar"]'),
];

/** The person lockup's circle: initials, bright on the strong rule's gray, named for its person. */
export const Initials: Story = {
  play: async ({ canvasElement }) => {
    const el = within(canvasElement).getByRole('img', { name: 'Sarah Kim' });
    await expect(el).toHaveTextContent('SK');
    const style = getComputedStyle(el);
    await expect(style.backgroundColor).toBe(computedColor(el, 'var(--line2)'));
    await expect(style.color).toBe(computedColor(el, 'var(--fg)'));
    // People are circles: a square box, rounded at least half its side.
    const box = el.getBoundingClientRect();
    await expect(box.width).toBeCloseTo(box.height, 3);
    await expect(parseFloat(style.borderTopLeftRadius)).toBeGreaterThanOrEqual(box.width / 2);
  },
};

/** A photo replaces the initials once it has loaded. */
export const Image: Story = {
  args: { name: 'Matt Rivera', src: PHOTO },
  play: async ({ canvasElement }) => {
    const img = await waitFor(() =>
      must(canvasElement.querySelector<HTMLImageElement>('[data-slot="avatar-image"]')),
    );
    await expect(img).toHaveAttribute('alt', '');
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-slot="avatar-fallback"]')).toBeNull(),
    );
    // The image fills the circle, and the circle still names the person.
    const root = within(canvasElement).getByRole('img', { name: 'Matt Rivera' });
    await expect(img.getBoundingClientRect().width).toBeCloseTo(
      root.getBoundingClientRect().width,
      1,
    );
  },
};

/** A broken photo leaves the initials in place — never an empty ring. */
export const BrokenImage: Story = {
  args: { name: 'Matt Rivera', src: 'data:image/png;base64,broken' },
  play: async ({ canvasElement }) => {
    // Give the image its chance to fail, then the initials are still there.
    await new Promise((r) => setTimeout(r, 100));
    await expect(canvasElement.querySelector('[data-slot="avatar-image"]')).toBeNull();
    await expect(
      must(canvasElement.querySelector('[data-slot="avatar-fallback"]')),
    ).toHaveTextContent('MR');
  },
};

/** The viewer at the rail's foot: the large size, a raised ground and a quiet ring. */
export const Viewer: Story = {
  args: { name: 'Teagan Atwater', size: 'lg', tone: 'viewer' },
  play: async ({ canvasElement }) => {
    const el = must(avatars(canvasElement)[0]);
    const style = getComputedStyle(el);
    await expect(style.backgroundColor).toBe(computedColor(el, 'var(--raise)'));
    await expect(style.borderTopColor).toBe(computedColor(el, 'var(--fg3)'));
    await expect(el).toHaveTextContent('TA');
  },
};

/** Initials: the first and last word's first letters, capitalized; one word gives one letter. */
export const InitialsRule: Story = {
  render: () => (
    <div className="flex items-center gap-(--space-2)">
      <Avatar name="Teagan Atwater" />
      <Avatar name="sarah" />
      <Avatar name="Rosa del Toro" />
      <Avatar name="  " />
    </div>
  ),
  play: async () => {
    await expect(initialsOf('Teagan Atwater')).toBe('TA');
    await expect(initialsOf('sarah')).toBe('S');
    await expect(initialsOf('Rosa del Toro')).toBe('RT');
    await expect(initialsOf('  ')).toBe('?');
  },
};

/** Each size is its surface's people token — 16 / 20 / 26 on the console, 22 / 28 / 30 on skater. */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-(--space-3)">
      <Avatar name="Sarah Kim" size="sm" />
      <Avatar name="Sarah Kim" size="md" />
      <Avatar name="Sarah Kim" size="lg" />
    </div>
  ),
  play: async ({ canvasElement, globals }) => {
    const surface = globals.surface as tokens.Surface;
    const keys = ['avatar-sm', 'avatar', 'avatar-lg'] as const;
    const els = avatars(canvasElement);
    for (const [i, key] of keys.entries()) {
      const box = must(els[i]).getBoundingClientRect();
      const want = tokens.size[surface][key].value * rootPx();
      await expect(box.width, key).toBeCloseTo(want, 1);
      await expect(box.height, key).toBeCloseTo(want, 1);
    }
  },
};

// ── The stacked faces ────────────────────────────────────────────────────────────────────────

function Colleagues({ max, size }: { max?: number; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <AvatarStack label="Also here" max={max} size={size}>
      <StackFace name="Kate Doyle" />
      <StackFace name="Matt Rivera" present />
      <StackFace name="Priya Lal" />
      <StackFace name="Rosa del Toro" present />
      <StackFace name="Sam Ortiz" />
    </AvatarStack>
  );
}

/**
 * The top bar's colleagues: present faces lead and sit over the idle ones; each tucks a quarter of
 * its diameter under the face before it, cut out by a 1.5 px ring in the field's color. Idle faces
 * are dim but solid — never see-through.
 */
export const Stack: Story = {
  render: () => <Colleagues />,
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group', { name: 'Also here' });
    const faces = avatars(group);
    await expect(faces.map((f) => f.getAttribute('aria-label'))).toEqual([
      'Matt Rivera',
      'Rosa del Toro',
      'Kate Doyle (idle)',
      'Priya Lal (idle)',
    ]);
    // A quarter of the diameter overlaps, face to face.
    const quarter = resolvePx(group, 'var(--size-avatar)') / 4;
    for (const gap of horizontalGaps(faces)) {
      await expect(Math.abs(gap + quarter)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    }
    // Earlier faces paint over later ones.
    const z = faces.map((f) => Number(getComputedStyle(f).zIndex));
    await expect(z).toEqual([...z].sort((a, b) => b - a));
    // The ground ring: 1.5 px in the field's color (a border snaps down to whole device pixels,
    // so 1 px on a 1× screen, 1.5 px on a 2× one).
    const first = must(faces[0]);
    const style = getComputedStyle(first);
    const dpr = window.devicePixelRatio;
    await expect(parseFloat(style.borderTopWidth)).toBe(Math.floor(1.5 * dpr) / dpr);
    await expect(style.borderTopColor).toBe(computedColor(first, 'var(--bg)'));
    // Present is lit; idle is dim and fully opaque.
    await expect(style.backgroundColor).toBe(computedColor(first, 'var(--fg3)'));
    const idle = must(faces[2]);
    await expect(getComputedStyle(idle).backgroundColor).toBe(computedColor(idle, 'var(--panel)'));
    await expect(getComputedStyle(idle).opacity).toBe('1');
  },
};

/** Past `max`, the rest fold into "+N", which names everyone it hides. */
export const StackOverflow: Story = {
  render: () => <Colleagues max={3} />,
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group', { name: 'Also here' });
    await expect(avatars(group)).toHaveLength(3);
    const more = within(group).getByRole('img', { name: '2 more: Priya Lal, Sam Ortiz' });
    await expect(more).toHaveTextContent('+2');
    // It sits in the run like a face: same size, same overlap.
    const last = must(avatars(group)[2]);
    await expect(more.getBoundingClientRect().width).toBeCloseTo(
      last.getBoundingClientRect().width,
      1,
    );
    const [gap] = horizontalGaps([last, more]);
    await expect(
      Math.abs((gap ?? 0) + resolvePx(group, 'var(--size-avatar)') / 4),
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
  },
};

/** The overlap follows the face size — a quarter of the small and large diameters too. */
export const StackSizes: Story = {
  render: () => (
    <div className="flex flex-col gap-heading">
      <Colleagues size="sm" />
      <Colleagues size="lg" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const [small, large] = [
      ...canvasElement.querySelectorAll<HTMLElement>('[data-slot="avatar-stack"]'),
    ];
    for (const [stack, token] of [
      [must(small), 'var(--size-avatar-sm)'],
      [must(large), 'var(--size-avatar-lg)'],
    ] as const) {
      const quarter = resolvePx(stack, token) / 4;
      for (const gap of horizontalGaps(avatars(stack))) {
        await expect(Math.abs(gap + quarter)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      }
    }
  },
};

// ── Board and four-up ────────────────────────────────────────────────────────────────────────

function Board() {
  return (
    <div className="flex flex-col gap-heading">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <div key={size} className="flex items-center gap-(--space-3)">
          <span className={`${KICKER} w-[3em]`}>{size}</span>
          <Avatar name="Sarah Kim" size={size} />
          <Avatar name="Matt Rivera" size={size} src={PHOTO} />
          <Avatar name="Teagan Atwater" size={size} tone="viewer" />
          <Colleagues size={size} max={3} />
        </div>
      ))}
    </div>
  );
}

/** Every size × form in all four maps: circles everywhere, and denser on the console. */
export const FourUp: Story = {
  render: () => <Board />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const widths = new Set<number>();
    for (const q of quads) {
      for (const el of avatars(q)) {
        const box = el.getBoundingClientRect();
        await expect(box.width).toBeCloseTo(box.height, 3);
      }
      widths.add(Math.round(must(avatars(q)[0]).getBoundingClientRect().width));
    }
    // The small circle differs by surface (16 vs 22).
    await expect(widths.size).toBe(2);
  },
};
