import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { expectNoSidewaysScroll, must } from '@/components/kit/storyKit';

import { FlagBoard } from './flagBoard';
import {
  PHOTO_BYTES_MISSING,
  PHOTO_DECIDED,
  PHOTO_FULL,
  PHOTO_HIDDEN,
  PHOTO_ITEM,
  PHOTO_MAX,
  PHOTO_NO_ACCESS,
  PHOTO_NO_FILE,
  PHOTO_OFF_REPORT,
  PHOTO_OWN,
  PHOTO_PURGED,
  PHOTO_REMOVED,
  PHOTO_THIRD,
  PHOTO_UPLOADER_GONE,
  PHOTO_WITHDRAWN,
} from './photoFixtures';
import type { PhotoView } from './photoModel';

/**
 * Board 2.7 (Content flags · Photo) at the boards' inspector size, and every photo state no board
 * draws. Render `Board27` beside `inbox-handler-v5.html?h=photo` (the whole page is
 * `Photo page`). The three writes' words — Hide, Remove (their dialogs) and Restore (one press, its
 * receipt) — say what the dev proof showed: off its link now, a device that opened it may keep it.
 *
 * **No read of an image's load state.** What keeps the full photo off the network is asserted
 * directly: no `<img>` and no attribute holding its address until *Show*. The mosaic's paint is
 * waited on through its own marker (`data-drawn`), read fresh inside one retry.
 */
const meta = {
  title: 'Admin/Inbox/Flag handler/Photo',
  component: FlagBoard,
  globals: { surface: 'admin', mode: 'dark' },
  parameters: { layout: 'fullscreen' },
  args: { item: PHOTO_ITEM, onWrite: fn(async () => true) },
} satisfies Meta<typeof FlagBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const slot = (root: ParentNode, name: string) => {
  const el = root.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (el === null) throw new Error(`No [data-slot="${name}"] drawn`);
  return el;
};
const slots = (root: ParentNode, name: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];
const pane = (root: HTMLElement) => slot(root, 'story-inspector');
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const bar = (root: HTMLElement) => root.querySelector<HTMLElement>('[role="toolbar"]');
/** The bar's key buttons by label, in order. */
const barButtons = (root: HTMLElement) =>
  [...(bar(root)?.querySelectorAll<HTMLElement>('button[aria-keyshortcuts]') ?? [])].map((b) =>
    (b.textContent ?? '').slice(0, -(b.getAttribute('aria-keyshortcuts') ?? '').length),
  );
const photoOf = (item: typeof PHOTO_ITEM) => (item.target as unknown as { photo: PhotoView }).photo;

/** No element anywhere holds `address` in an attribute: it is not in the page to fetch. */
const nowhere = (address: string) =>
  [...document.querySelectorAll('*')].every((el) =>
    [...el.attributes].every((a) => !a.value.includes(address)),
  );

/** The stage's mosaic, painted: read fresh, inside the caller's retry. */
const painted = (root: HTMLElement) => {
  const mosaic = root.querySelector<HTMLCanvasElement>(
    '[data-slot="photo-stage"] [data-slot="photo-mosaic"]',
  );
  expect(mosaic).not.toBeNull();
  expect(mosaic?.dataset.drawn).toMatch(/^24x\d+$/);
};

/** Board 2.7: Sarah's flag on the first of Kate's four Crystal Lake photos, pixelated. */
export const Board27: Story = {
  play: async ({ canvasElement }) => {
    const head = slot(canvasElement, 'flag-head');
    await expect(head).toHaveTextContent('Flag on a photo');
    await expect(slot(head, 'flag-head-sub')).toHaveTextContent('Inappropriate · 2 hours ago');
    await expect(slot(head, 'flag-history')).toHaveTextContent('Open in Reports');
    const stage = slot(canvasElement, 'photo-stage');
    // Pixelated: the full photo is nowhere in the page, and no image element exists.
    await expect(stage.querySelector('img')).toBeNull();
    await expect(nowhere(must(PHOTO_FULL[photoOf(PHOTO_ITEM).photoId]))).toBe(true);
    await waitFor(() => painted(canvasElement));
    await expect(slot(stage, 'photo-veil')).toHaveTextContent('Pixelated until you choose to look');
    await expect(slot(stage, 'photo-show')).toHaveTextContent('Show the photo');
    await expect(slot(stage, 'photo-caption')).toHaveTextContent('11 Oct 14:22 · Crystal Lake');
    await expect(slot(stage, 'photo-place')).toHaveTextContent('1 of 4 on the report');
    // On the same report: four thumbnails, the flagged one marked, none an image yet.
    const thumbs = slots(canvasElement, 'photo-sibling');
    await expect(thumbs).toHaveLength(4);
    await expect(thumbs[0]).toHaveAttribute('data-self');
    await expect(slot(must(thumbs[0]), 'photo-sibling-label')).toHaveTextContent('Flagged');
    await expect(canvasElement.querySelectorAll('[data-slot="photo-sibling"] img')).toHaveLength(0);
    // The flag and the uploader.
    await expect(canvasElement).toHaveTextContent('Kids’ faces, close up.');
    await expect(canvasElement).toHaveTextContent('Kate Donovan');
    // 2.7's bar: Photo first, then Flag; Remove's tooltip names the 30 days.
    await expect(barButtons(canvasElement)).toEqual(['Hide', 'Remove', 'Dismiss']);
  },
};

/** Board 2.7 in light mode. */
export const Board27Light: Story = {
  ...Board27,
  globals: { surface: 'admin', mode: 'light' },
};

/** *Show the photo* reveals the staged photo's own address; *Pixelate again* takes it back. */
export const Shown: Story = {
  args: { item: PHOTO_THIRD },
  play: async ({ canvasElement }) => {
    const stage = slot(canvasElement, 'photo-stage');
    const photo = photoOf(PHOTO_THIRD);
    const full = must(PHOTO_FULL[photo.photoId]);
    await expect(nowhere(full)).toBe(true);
    await userEvent.click(within(stage).getByRole('button', { name: /Show the photo/ }));
    await waitFor(() => expect(stage.querySelector('img')?.getAttribute('src')).toBe(full));
    // The flagged photo is the third, marked by its id.
    const self = must(
      canvasElement.querySelector<HTMLElement>('[data-slot="photo-sibling"][data-self]'),
    );
    await expect(self.dataset.photo).toBe(photo.photoId);
    await expect(canvasElement.querySelectorAll('[data-slot="photo-sibling"] img')).toHaveLength(4);
    await waitFor(() =>
      expect(within(stage).getByRole('button', { name: /Pixelate again/ })).toHaveFocus(),
    );
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(stage.querySelector('img')).toBeNull());
    await waitFor(() =>
      expect(within(stage).getByRole('button', { name: /Show the photo/ })).toHaveFocus(),
    );
  },
};

/** S toggles the stage while the inspector has focus; inert outside it and while a dialog has it. */
export const KeyboardShow: Story = {
  play: async ({ canvasElement }) => {
    const stage = slot(canvasElement, 'photo-stage');
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('s');
    await expect(stage.querySelector('img')).toBeNull();
    pane(canvasElement).focus();
    await waitFor(() => expect(document.activeElement).toBe(pane(canvasElement)));
    await userEvent.keyboard('h');
    await waitFor(() => expect(dialog()).not.toBeNull());
    await waitFor(() => expect(must(dialog()).contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('s');
    await expect(stage.querySelector('img')).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    pane(canvasElement).focus();
    await waitFor(() => expect(document.activeElement).toBe(pane(canvasElement)));
    await userEvent.keyboard('s');
    await waitFor(() => expect(stage.querySelector('img')).not.toBeNull());
    await userEvent.keyboard('s');
    await waitFor(() => expect(stage.querySelector('img')).toBeNull());
  },
};

const hideDialog = async (root: HTMLElement, key: 'h' | 'r') => {
  pane(root).focus();
  await waitFor(() => expect(document.activeElement).toBe(pane(root)));
  await userEvent.keyboard(key);
  await waitFor(() => expect(dialog()).not.toBeNull());
  return must(dialog());
};

/**
 * Hide: off its link now and shown to no one; a device that already opened it may keep it a while;
 * restorable at any time. Sent by ⌘⏎ from the reason, where the dialog's opening focus lands.
 */
export const HideDialog: Story = {
  play: async ({ canvasElement, args }) => {
    const d = await hideDialog(canvasElement, 'h');
    await expect(d).toHaveTextContent('Hide this photo?');
    await expect(d).toHaveTextContent('It comes off its link now and is shown to no one.');
    await expect(d).toHaveTextContent(
      'Anyone who already opened it may still see it on their own device.',
    );
    await expect(d).toHaveTextContent('You can restore it at any time.');
    await waitFor(() => expect(document.activeElement?.tagName).toBe('TEXTAREA'));
    await userEvent.keyboard('Children’s faces');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() =>
      expect(args.onWrite).toHaveBeenCalledWith({
        kind: 'takeDown',
        status: 'hidden',
        reason: 'Children’s faces',
      }),
    );
    await waitFor(() => expect(dialog()).toBeNull());
    // Focus goes back where it was: inside the inspector, on the bar's Hide.
    await waitFor(() => expect(pane(canvasElement).contains(document.activeElement)).toBe(true));
  },
};

/** Remove: the same, and deleted for good in 30 days unless restored before then. */
export const RemoveDialog: Story = {
  play: async ({ canvasElement }) => {
    const d = await hideDialog(canvasElement, 'r');
    await expect(d).toHaveTextContent('Remove this photo?');
    await expect(d).toHaveTextContent('It comes off its link now and is shown to no one.');
    await expect(d).toHaveTextContent('may still see it on their own device.');
    await expect(d).not.toHaveTextContent('up to');
    await expect(d).toHaveTextContent(
      'It is deleted for good in 30 days unless it is restored before then.',
    );
  },
};

/** Remove in light mode. */
export const RemoveDialogLight: Story = {
  ...RemoveDialog,
  globals: { surface: 'admin', mode: 'light' },
};

/** Hidden before this flag was read: Restore, at once. */
export const Hidden: Story = {
  args: { item: PHOTO_HIDDEN },
  play: async ({ canvasElement, args }) => {
    await expect(slot(canvasElement, 'subject-down')).toHaveTextContent(
      'Hidden before this flag was read',
    );
    await expect(barButtons(canvasElement)).toEqual(['Restore', 'Dismiss']);
    pane(canvasElement).focus();
    await userEvent.keyboard('r');
    await waitFor(() => expect(args.onWrite).toHaveBeenCalledWith({ kind: 'restore' }));
  },
};

/** Removed inside its 30 days: its deletion day. */
export const Removed: Story = {
  args: { item: PHOTO_REMOVED },
  play: async ({ canvasElement }) => {
    await expect(slot(canvasElement, 'photo-purge-on')).toHaveTextContent(
      'Its file is deleted on 12 Nov unless it is restored',
    );
  },
};

/** The file deleted on the clock: what was removed and when; no image, no Show. */
export const Purged: Story = {
  args: { item: PHOTO_PURGED },
  play: async ({ canvasElement }) => {
    // Never an image: in the same retry as the tombstone drawn, so an absence can't pass early.
    await waitFor(() => {
      expect(slot(canvasElement, 'photo-purged')).toHaveTextContent(
        'The file was deleted on 10 Oct',
      );
      expect(slot(canvasElement, 'photo-purged')).toHaveTextContent('removed on 10 Sep');
      expect(canvasElement.querySelector('[data-slot="photo-stage"]')).toBeNull();
      expect(
        canvasElement.querySelector(
          '[data-slot="photo-sibling"][data-self] img, [data-slot="photo-sibling"][data-self] canvas',
        ),
      ).toBeNull();
      expect(barButtons(canvasElement)).toEqual(['Dismiss']);
    });
  },
};

/** A viewer without content.read: served no address — said, with no image and no Show. */
export const NoAccess: Story = {
  args: { item: PHOTO_NO_ACCESS },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(slot(canvasElement, 'photo-noAccess')).toHaveTextContent(
        'shown only to staff who can read hidden content',
      );
      // The report's frames stand empty, the flagged one still marked.
      expect(slots(canvasElement, 'photo-sibling')).toHaveLength(4);
      // No image of any size: no img, no mosaic, no Show.
      expect(canvasElement.querySelector('img')).toBeNull();
      expect(canvasElement.querySelector('[data-slot="photo-mosaic"]')).toBeNull();
      expect(within(canvasElement).queryByRole('button', { name: /Show/ })).toBeNull();
    });
  },
};

/** Its rotation found the file missing: said, no image, and no Restore (the server refuses one). */
export const BytesMissing: Story = {
  args: { item: PHOTO_BYTES_MISSING },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(slot(canvasElement, 'photo-missing')).toHaveTextContent(
        'The file for this photo is missing',
      );
      expect(slot(canvasElement, 'photo-missing')).toHaveTextContent('can’t be restored');
      expect(canvasElement.querySelector('[data-slot="photo-stage"]')).toBeNull();
      expect(barButtons(canvasElement)).toEqual(['Dismiss']);
    });
  },
};

/** No file served to a viewer who may see it. */
export const NoFile: Story = {
  args: { item: PHOTO_NO_FILE },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(slot(canvasElement, 'photo-noFile')).toHaveTextContent(
        'The file for this photo couldn’t be found',
      );
      expect(canvasElement.querySelector('[data-slot="photo-stage"]')).toBeNull();
    });
  },
};

/** The busiest report: 24 served of more, most moderated, the flagged one the seventh. */
export const MaxPhotos: Story = {
  args: { item: PHOTO_MAX },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(slot(canvasElement, 'photo-place')).toHaveTextContent('7 of 24 on the report');
      // The read's twelve others and the flagged one in its own place (the seventh).
      const thumbs = slots(canvasElement, 'photo-sibling');
      expect(thumbs).toHaveLength(13);
      expect(thumbs[6]).toHaveAttribute('data-self');
      expect(slot(canvasElement, 'photo-same-report-cut')).toHaveTextContent(
        'Showing 13 of 24 photos',
      );
      // Another photo's open flag links its own Inbox item, by the flag's id.
      const flagLinks = slots(canvasElement, 'photo-sibling-flag');
      expect(flagLinks.map((a) => a.getAttribute('href'))).toEqual([
        '#/admin/inbox?item=flag%3Af_ph_2',
        '#/admin/inbox?item=flag%3Af_ph_10',
      ]);
    });
    await expectNoSidewaysScroll(pane(canvasElement));
  },
};

/** A photo on no report: no list, no place on one; its caption quoted. */
export const OffReport: Story = {
  args: { item: PHOTO_OFF_REPORT },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(slot(canvasElement, 'photo-caption-words')).toHaveTextContent(
        '“Pressure ridge off the point”',
      );
      expect(canvasElement.querySelector('[data-slot="photo-same-report"]')).toBeNull();
      expect(canvasElement.querySelector('[data-slot="photo-place"]')).toBeNull();
    });
  },
};

/** The viewer's own photo: every verb refused, no bar. */
export const Own: Story = {
  args: { item: PHOTO_OWN },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(slot(canvasElement, 'photo-subject')).toBeInTheDocument();
      expect(slot(canvasElement, 'photo-stage')).toBeInTheDocument();
      expect(bar(canvasElement)).toBeNull();
    });
  },
};

/** Decided by a colleague while open: the lock, no bar. */
export const Decided: Story = {
  args: { item: PHOTO_DECIDED },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(canvasElement.querySelector('[data-slot="inbox-inspector-lock"]')).not.toBeNull();
      expect(bar(canvasElement)).toBeNull();
    });
  },
};

/** The uploader has left: never named. */
export const UploaderGone: Story = {
  args: { item: PHOTO_UPLOADER_GONE },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(barButtons(canvasElement)).toEqual(['Hide', 'Remove', 'Dismiss']);
      expect(canvasElement).not.toHaveTextContent('Kate Donovan');
    });
  },
};

/** Its uploader took it down while this flag held it: kept out of sight, the line says so. */
export const Withdrawn: Story = {
  args: { item: PHOTO_WITHDRAWN },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(slot(canvasElement, 'photo-withdrawn')).toHaveTextContent(
        'Its uploader took it down on 14 Oct',
      );
      // It can't be restored: the deletion isn't "unless restored", and the server offers no Restore.
      expect(slot(canvasElement, 'photo-purge-on')).toHaveTextContent('it can’t be restored');
      expect(slot(canvasElement, 'photo-purge-on')).not.toHaveTextContent('unless');
      expect(barButtons(canvasElement)).toEqual(['Dismiss']);
    });
  },
};

/** Board 2.7 at 360 px: the stage, the thumbnails and the bar stay inside the pane. */
export const Narrow: Story = {
  render: (args) => (
    <div style={{ width: 360 }}>
      <FlagBoard {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => painted(canvasElement));
    await expectNoSidewaysScroll(pane(canvasElement));
  },
};

/** At 360 px in light mode. */
export const NarrowLight: Story = {
  ...Narrow,
  globals: { surface: 'admin', mode: 'light' },
};
