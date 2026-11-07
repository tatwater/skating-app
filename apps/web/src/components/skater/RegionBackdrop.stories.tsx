import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { RegionBackdrop, RegionCredit } from './RegionBackdrop';

const meta = {
  title: 'Skater/Region backdrop',
  component: RegionBackdrop,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className="relative h-dvh bg-bg">
      <RegionBackdrop />
      <RegionCredit className="absolute right-6 bottom-6" />
    </div>
  ),
} satisfies Meta<typeof RegionBackdrop>;

export default meta;
type Story = StoryObj<typeof meta>;

const picture = (root: HTMLElement, theme: 'dark' | 'light') =>
  root.querySelector<HTMLImageElement>(`img[data-theme-picture="${theme}"]`) as HTMLImageElement;

/** Covers the canvas, anchored at the bottom edge — the NY/MA line stays just below it. */
async function coversFromTheBottom(img: HTMLImageElement) {
  const style = getComputedStyle(img);
  await expect(style.objectFit).toBe('cover');
  await expect(style.objectPosition).toBe('50% 100%');
  await waitFor(() => expect(img.complete && img.naturalWidth > 0).toBe(true));
}

/**
 * Dark: the dark picture shows, and the light one is never fetched — it is `display: none` and
 * `loading="lazy"`, which is what keeps it off the network. The test asserts that pair rather than
 * `complete === false`: Chromium decodes a lazy image at once when its URL is already in the
 * process's memory cache, so `complete` flipped to `true` whenever a light-mode story over this
 * backdrop ran earlier in the same browser (a cache hit, not a fetch — and red on CI's file order).
 */
export const Dark: Story = {
  globals: { surface: 'skater', mode: 'dark' },
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(picture(canvasElement, 'dark')).display).toBe('block');
    await expect(getComputedStyle(picture(canvasElement, 'light')).display).toBe('none');
    await expect(picture(canvasElement, 'light').loading).toBe('lazy');
    await coversFromTheBottom(picture(canvasElement, 'dark'));
  },
};

/** Light: the other way round. */
export const Light: Story = {
  globals: { surface: 'skater', mode: 'light' },
  play: async ({ canvasElement }) => {
    await expect(getComputedStyle(picture(canvasElement, 'light')).display).toBe('block');
    await expect(getComputedStyle(picture(canvasElement, 'dark')).display).toBe('none');
    await expect(picture(canvasElement, 'dark').loading).toBe('lazy');
    await coversFromTheBottom(picture(canvasElement, 'light'));
  },
};

/**
 * No `data-mode` on the root (the "System" preference): exactly one picture shows, whichever the OS
 * prefers, through the same media query the token sheet uses.
 */
export const System: Story = {
  globals: { surface: 'skater', mode: 'dark' },
  play: async ({ canvasElement }) => {
    const root = document.documentElement;
    root.removeAttribute('data-mode');
    try {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const shown = prefersDark ? 'dark' : 'light';
      const hidden = prefersDark ? 'light' : 'dark';
      await expect(getComputedStyle(picture(canvasElement, shown)).display).toBe('block');
      await expect(getComputedStyle(picture(canvasElement, hidden)).display).toBe('none');
    } finally {
      root.setAttribute('data-mode', 'dark');
    }
  },
};
