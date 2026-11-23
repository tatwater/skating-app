import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { PhotoStage, PhotoThumb } from './photo-stage';
import { must } from './storyKit';

/** A generated scene (a shore under a gray sky), never a real photo: `size` sets its pixels. */
const scene = (w: number, h: number, tag: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><!--${tag}--><rect width="${w}" height="${h * 0.4}" fill="rgb(96,100,104)"/><rect y="${h * 0.4}" width="${w}" height="${h * 0.6}" fill="rgb(52,56,58)"/><ellipse cx="${w * 0.45}" cy="${h * 0.5}" rx="${w * 0.06}" ry="${h * 0.12}" fill="rgb(160,118,92)"/></svg>`,
  )}`;
const THUMB = scene(400, 250, 'thumb');
const FULL = scene(1600, 1000, 'full');

/** The stage (board 2.7), pixelated until Show; a thumbnail beside it, and one with no address. */
function Stage() {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex w-[40rem] max-w-full flex-col gap-(--space-3)">
      <PhotoStage
        thumb={THUMB}
        full={FULL}
        shown={shown}
        onShow={() => setShown(true)}
        onPixelate={() => setShown(false)}
        alt="A shore"
        label="The photo, pixelated"
        veil="Pixelated until you choose to look"
        showLabel="Show the photo"
        pixelateLabel="Pixelate again"
        caption="11 Oct 14:22 · Crystal Lake"
        place="1 of 2"
      />
      <div className="flex gap-(--space-2_5)">
        <PhotoThumb thumb={THUMB} shown={shown} label="Photo 1, pixelated" alt="Photo 1" selected />
        <PhotoThumb thumb={null} shown={shown} label="Photo 2" alt="Photo 2" />
      </div>
    </div>
  );
}

const meta = {
  title: 'Kit/PhotoStage',
  component: Stage,
  parameters: { fourUp: true },
} satisfies Meta<typeof Stage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Pixelated: the full image's address is nowhere in the page; the mosaic is the canvas itself. */
export const FourUp: Story = {
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      await waitFor(() => {
        const stage = must(q.querySelector<HTMLElement>('[data-slot="photo-stage"]'));
        expect(stage.querySelector('img')).toBeNull();
        const mosaic = must(stage.querySelector<HTMLCanvasElement>('[data-slot="photo-mosaic"]'));
        expect(mosaic.width).toBe(24);
        expect(mosaic.dataset.drawn).toMatch(/^24x\d+$/);
        // No attribute anywhere in the quad holds the full image's address.
        const attrs = [...q.querySelectorAll('*')].flatMap((el) =>
          [...el.attributes].map((a) => a.value),
        );
        expect(attrs.some((v) => v.includes(FULL))).toBe(false);
        // A thumbnail with no address is an empty dashed frame, never an image.
        const empty = q.querySelectorAll<HTMLElement>('[data-slot="photo-thumb"]')[1];
        expect(empty?.querySelector('img, canvas')).toBeNull();
      });
    }
  },
};

/** Show mounts the full image, focus moves to Pixelate again; Pixelate puts the mosaic back. */
export const Shown: Story = {
  play: async ({ canvasElement }) => {
    const q = must(canvasElement.querySelector<HTMLElement>('[data-theme-scope]'));
    const stage = must(q.querySelector<HTMLElement>('[data-slot="photo-stage"]'));
    await userEvent.click(within(stage).getByRole('button', { name: /Show the photo/ }));
    await waitFor(() => {
      expect(stage.querySelector('img')?.getAttribute('src')).toBe(FULL);
      expect(within(stage).getByRole('button', { name: /Pixelate again/ })).toHaveFocus();
    });
    await userEvent.click(within(stage).getByRole('button', { name: /Pixelate again/ }));
    await waitFor(() => {
      expect(stage.querySelector('img')).toBeNull();
      expect(within(stage).getByRole('button', { name: /Show the photo/ })).toHaveFocus();
    });
  },
};
