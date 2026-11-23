import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/components/kit/toast';
import { KeysProvider } from '@/lib/keys';
import { stubJsdomAnimations } from '../../../body/tabs/jsdomStubs';
import { UndoProvider } from '../../../shell/undo';
import { LANES } from '../../list/inboxFixtures';
import type { InboxItemView } from '../../list/inboxTypes';
import {
  harness as h,
  installInboxRouteMocks,
  must,
  resetHarness,
} from '../../testing/routeHarness';
import { dayMonth } from './flagFormat';
import {
  PHOTO_DECIDED,
  PHOTO_FULL,
  PHOTO_HIDDEN,
  PHOTO_ITEM,
  PHOTO_MIXED,
  PHOTO_NO_ACCESS,
  PHOTO_PURGED,
  PHOTO_THIRD,
  PHOTO_UPLOADER_GONE,
  scene,
} from './photoFixtures';
import type { PhotoView } from './photoModel';

/**
 * **A photo flag through the real route and view** (the shared harness: only the router, the role
 * and the read layer stood in, plus the mutations and the theme): a `flag:photo` item opens the flag
 * handler's photo subject, not the placeholder; the stage is pixelated with the full image nowhere in
 * the page until *Show the photo*; each lever calls its write with the item's id and its receipt's
 * Undo looks for the staged photo — the third of four, never the first; a refusal reaches a toast; a
 * decided item drops the bar; a viewer the server serves no address sees no image and no *Show*.
 */

const writes = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  answer: {} as Record<string, (args: Record<string, unknown>) => unknown>,
}));
const undo = vi.hoisted(() => ({ looked: [] as unknown[] }));

vi.doMock('convex/react', async (orig) => ({
  ...(await orig<typeof import('convex/react')>()),
  // The author menu reads People on open; still loading here (its levers are People's to test).
  useQuery: () => undefined,
  useMutation: (ref: never) => {
    const name = getFunctionName(ref);
    return async (args: Record<string, unknown>) => {
      writes.calls.push({ name, args });
      const answer = writes.answer[name];
      if (answer) return answer(args);
      // A decision's answer that names its row but not what undoing it asks: the receipt looks the
      // row up by its target, so the test reads which target the receipt is about.
      return { itemId: args.itemId, actionId: 'ma_photo', flagsClosed: 1, undoable: true };
    };
  },
}));
vi.doMock('@/components/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));

const { Route } = await installInboxRouteMocks();

const ui = () => (
  <Toaster>
    <UndoProvider
      server={{
        latestOwn: async (target) => {
          undo.looked.push(target);
          return null;
        },
        run: async () => {},
      }}
    >
      <Route />
    </UndoProvider>
  </Toaster>
);
const mount = () => render(ui(), { wrapper: KeysProvider });

beforeAll(() => {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () =>
      ({
        cancel() {},
        pause() {},
        play() {},
        currentTime: 0,
        finished: Promise.resolve(),
      }) as unknown as Animation,
  });
  stubJsdomAnimations();
});

const open = (item: InboxItemView) => {
  h.lanes = LANES;
  h.search = { lane: 'flags', item: item.itemId };
  h.answers['inbox:item'] = () => ({ item, pending: false });
  h.answers['inbox:itemMap'] = () => ({ map: null, pending: false });
  // The full image, only as `inbox.photoReveal` answers it (never in the item).
  h.answers['inbox:photoReveal'] = (args) => ({
    url: PHOTO_FULL[(args as { photoId: string }).photoId] ?? null,
  });
};
const revealsAsked = () => h.asked.filter((a) => a.name === 'inbox:photoReveal');

beforeEach(() => {
  resetHarness();
  writes.calls = [];
  writes.answer = {};
  undo.looked = [];
});

const inspector = () =>
  must(document.querySelector<HTMLElement>('[data-pane="detail"]'), 'the inspector');
const called = (name: string) => writes.calls.filter((c) => c.name === name);
const photoOf = (item: InboxItemView) =>
  (item as Extract<InboxItemView, { kind: 'flag' }> & { target: { photo: PhotoView } }).target
    .photo;
const STAGED = photoOf(PHOTO_THIRD);
const STAGED_FULL = must(PHOTO_FULL[STAGED.photoId], 'the staged photo’s full image');
const FIRST = must(STAGED.siblings[0], 'the first photo');

/** Every attribute value in the document, for "this address is nowhere in the page". */
const everyAttribute = () =>
  [...document.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.value));

describe('a photo flag, through the route and the view', () => {
  it('opens the flag handler’s photo subject, not the placeholder', () => {
    open(PHOTO_THIRD);
    mount();
    expect(inspector().querySelector('[data-slot="photo-subject"]')).not.toBeNull();
    expect(inspector().querySelector('[data-slot="inbox-placeholder-facts"]')).toBeNull();
    // 2.7's head and its two columns: the flag, the uploader.
    expect(inspector().querySelector('[data-slot="flag-head"]')).toHaveTextContent(
      'Flag on a photo',
    );
    expect(inspector()).toHaveTextContent('Kids’ faces, close up.');
    expect(inspector()).toHaveTextContent('Kate Donovan');
  });

  it('keeps the full image out of the page and its data until Show, then draws the staged photo’s', async () => {
    open(PHOTO_THIRD);
    mount();
    const stage = must(
      inspector().querySelector<HTMLElement>('[data-slot="photo-stage"]'),
      'the stage',
    );
    // Pixelated: no image element, no attribute anywhere holding the full address.
    expect(stage.querySelector('img')).toBeNull();
    expect(everyAttribute().some((v) => v.includes(STAGED_FULL))).toBe(false);
    // Nor in the page's data: the item carries no full address, and the reveal isn't asked yet.
    expect(JSON.stringify(PHOTO_THIRD)).not.toContain(STAGED_FULL);
    expect(revealsAsked()).toEqual([]);
    const mosaic = must(stage.querySelector<HTMLCanvasElement>('canvas'), 'the mosaic');
    expect(mosaic).toHaveAttribute('aria-hidden', 'true');
    // The bitmap is the mosaic itself: 24 cells across, never the photo's own size.
    expect(mosaic.width).toBe(24);
    expect(stage).toHaveAccessibleName('The flagged photo, pixelated');
    // The thumbnails are pixelated the same way: no image elements at all.
    expect(inspector().querySelectorAll('[data-slot="photo-sibling"] img')).toHaveLength(0);

    fireEvent.click(within(stage).getByRole('button', { name: /Show the photo/ }));
    // Show asks `inbox.photoReveal` for the staged photo, by its own id.
    await waitFor(() =>
      expect(revealsAsked().map((a) => a.args.photoId)).toContain(STAGED.photoId),
    );
    const img = await waitFor(() => {
      const el = must(stage.querySelector('img'), 'the revealed photo');
      expect(el.getAttribute('src')).toBe(STAGED_FULL);
      return el;
    });
    // The staged photo's own address — the third's, not the first's.
    expect(img.getAttribute('src')).toBe(STAGED_FULL);
    expect(img.getAttribute('src')).not.toBe(scene(1, 'full'));
    // Its thumbnail on the report is the one marked, by id.
    const self = must(
      inspector().querySelector<HTMLElement>('[data-slot="photo-sibling"][data-self]'),
      'the flagged thumbnail',
    );
    expect(self.dataset.photo).toBe(STAGED.photoId);
    expect(self.dataset.photo).not.toBe(FIRST.photoId);
    // Revealed, its neighbors still up with no flag of their own show too (all three here).
    expect(inspector().querySelectorAll('[data-slot="photo-sibling"] img')).toHaveLength(4);
    // Focus moves to the button that replaced the pressed one.
    expect(within(stage).getByRole('button', { name: /Pixelate again/ })).toHaveFocus();
  });

  it('Show reveals the staged photo and its unflagged, still-visible neighbors only', async () => {
    open(PHOTO_MIXED);
    mount();
    const stage = must(
      inspector().querySelector<HTMLElement>('[data-slot="photo-stage"]'),
      'stage',
    );
    fireEvent.click(within(stage).getByRole('button', { name: /Show the photo/ }));
    await waitFor(() => expect(stage.querySelector('img')).not.toBeNull());
    const revealed = [...inspector().querySelectorAll<HTMLElement>('[data-slot="photo-sibling"]')]
      .filter((li) => li.querySelector('img') !== null)
      .map((li) => li.dataset.photo);
    // The staged third and the unflagged fourth; the first (its own flag) and the second (hidden)
    // stay pixelated, the first linking its own item.
    expect(revealed).toEqual(['ph_3', 'ph_4']);
    for (const id of ['ph_1', 'ph_2']) {
      const li = must(
        inspector().querySelector<HTMLElement>(`[data-slot="photo-sibling"][data-photo="${id}"]`),
        id,
      );
      expect(li.querySelector('img')).toBeNull();
    }
    expect(
      inspector().querySelector('[data-photo="ph_1"] [data-slot="photo-sibling-flag"]'),
    ).not.toBeNull();
  });

  it('a reveal never carries to the next item: its photo mounts pixelated, and its full image is never read', async () => {
    const byRef: Record<string, InboxItemView> = {
      [PHOTO_THIRD.itemId]: PHOTO_THIRD,
      [PHOTO_ITEM.itemId]: PHOTO_ITEM,
    };
    h.lanes = LANES;
    h.search = { lane: 'flags', item: PHOTO_THIRD.itemId };
    h.answers['inbox:item'] = (args) => ({
      item: byRef[args.ref as string] ?? null,
      pending: false,
    });
    h.answers['inbox:itemMap'] = () => ({ map: null, pending: false });
    h.answers['inbox:photoReveal'] = (args) => ({
      url: PHOTO_FULL[(args as { photoId: string }).photoId] ?? null,
    });
    const page = mount();
    const stage = () =>
      must(inspector().querySelector<HTMLElement>('[data-slot="photo-stage"]'), 'the stage');
    fireEvent.click(within(stage()).getByRole('button', { name: /Show the photo/ }));
    await waitFor(() => expect(stage().querySelector('img')).not.toBeNull());
    // Another photo flag opens in the same inspector.
    const next = photoOf(PHOTO_ITEM);
    h.search = { lane: 'flags', item: PHOTO_ITEM.itemId };
    page.rerender(ui());
    await waitFor(() =>
      expect(inspector().querySelector('[data-slot="photo-sibling"][data-self]')).toHaveAttribute(
        'data-photo',
        next.photoId,
      ),
    );
    // Pixelated: no image, nothing holding its full address, and its reveal never asked.
    expect(stage().querySelector('img')).toBeNull();
    expect(everyAttribute().some((v) => v.includes(must(PHOTO_FULL[next.photoId], 'full')))).toBe(
      false,
    );
    expect(revealsAsked().some((a) => a.args.photoId === next.photoId)).toBe(false);
  });

  it('S shows the photo while the inspector has focus, and is inert while a dialog does', async () => {
    open(PHOTO_THIRD);
    mount();
    const pane = inspector();
    act(() => pane.focus());
    fireEvent.keyDown(pane, { key: 'h', code: 'KeyH' });
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement ?? dialog, { key: 's', code: 'KeyS' });
    expect(pane.querySelector('[data-slot="photo-stage"] img')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    act(() => pane.focus());
    fireEvent.keyDown(pane, { key: 's', code: 'KeyS' });
    await waitFor(() =>
      expect(pane.querySelector('[data-slot="photo-stage"] img')?.getAttribute('src')).toBe(
        STAGED_FULL,
      ),
    );
  });

  it('Hide asks a reason and calls takeDown with the item’s id; the Undo is the staged photo’s', async () => {
    open(PHOTO_THIRD);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: /^Hide/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Hide this photo?');
    // What the dev proof showed: off its link now; a device that opened it may keep it a while.
    expect(dialog).toHaveTextContent('It comes off its link now and is shown to no one.');
    expect(dialog).toHaveTextContent('You can restore it at any time.');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Children’s faces' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide' }));
    await waitFor(() =>
      expect(called('inboxWrites:takeDown')).toEqual([
        {
          name: 'inboxWrites:takeDown',
          args: { itemId: PHOTO_THIRD.itemId, status: 'hidden', reason: 'Children’s faces' },
        },
      ]),
    );
    await waitFor(() =>
      expect(undo.looked).toEqual([{ targetType: 'photo', targetId: STAGED.photoId }]),
    );
    expect(undo.looked).not.toContainEqual({ targetType: 'photo', targetId: FIRST.photoId });
    // The receipt says what the hide did: off its link, shown to no one, restorable.
    await waitFor(() =>
      expect(
        screen.getAllByText(/Off its link and shown to no one; restorable at any time/).length,
      ).toBeGreaterThan(0),
    );
  });

  it('Remove says the 30 days and calls takeDown removed', async () => {
    open(PHOTO_THIRD);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: /^Remove/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Remove this photo?');
    expect(dialog).toHaveTextContent(
      'It is deleted for good in 30 days unless it is restored before then.',
    );
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Faces' } });
    // A removal is destructive: the kit's armed step takes two presses.
    const send = within(dialog).getByRole('button', { name: 'Remove' });
    fireEvent.click(send);
    fireEvent.click(within(dialog).getByRole('button', { name: /Remove/ }));
    await waitFor(() =>
      expect(called('inboxWrites:takeDown')).toEqual([
        {
          name: 'inboxWrites:takeDown',
          args: { itemId: PHOTO_THIRD.itemId, status: 'removed', reason: 'Faces' },
        },
      ]),
    );
  });

  it('Dismiss calls dismissFlags with the item’s id only', async () => {
    open(PHOTO_THIRD);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: /^Dismiss/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(called('inboxWrites:dismissFlags')).toEqual([
        { name: 'inboxWrites:dismissFlags', args: { itemId: PHOTO_THIRD.itemId } },
      ]),
    );
  });

  it('a photo already hidden offers Restore, which calls restoreAndDismiss at once', async () => {
    open(PHOTO_HIDDEN);
    mount();
    expect(within(inspector()).queryByRole('button', { name: /^Hide/ })).toBeNull();
    fireEvent.click(within(inspector()).getByRole('button', { name: /^Restore/ }));
    await waitFor(() =>
      expect(called('inboxWrites:restoreAndDismiss')).toEqual([
        { name: 'inboxWrites:restoreAndDismiss', args: { itemId: PHOTO_HIDDEN.itemId } },
      ]),
    );
    await waitFor(() =>
      expect(undo.looked).toEqual([
        { targetType: 'photo', targetId: photoOf(PHOTO_HIDDEN).photoId },
      ]),
    );
  });

  it('a refusal reaches a toast in the server’s words, and the dialog stays', async () => {
    writes.answer['inboxWrites:takeDown'] = () => {
      throw new ConvexError('Someone else decided this a moment ago');
    };
    open(PHOTO_THIRD);
    mount();
    fireEvent.click(within(inspector()).getByRole('button', { name: /^Hide/ }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Faces' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide' }));
    // The toast draws its words twice (its card and its live region's copy).
    await waitFor(() =>
      expect(screen.getAllByText('Someone else decided this a moment ago').length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.getAllByText('Not saved · Crystal Lake').length).toBeGreaterThan(0);
    expect(within(inspector()).queryByText(/Someone else decided/)).toBeNull();
    // Never also printed in the dialog, which keeps what was typed.
    expect(dialog).not.toHaveTextContent('Someone else decided this');
    expect(within(dialog).getByRole('textbox')).toHaveValue('Faces');
  });

  it('a decided item drops the bar', () => {
    open(PHOTO_DECIDED);
    mount();
    expect(inspector().querySelector('[data-slot="flag-actions"]')).toBeNull();
    expect(within(inspector()).queryByRole('button', { name: /^Hide/ })).toBeNull();
  });

  it('a viewer the server serves no address sees no image and no Show', () => {
    open(PHOTO_NO_ACCESS);
    mount();
    const pane = inspector();
    expect(pane.querySelector('[data-slot="photo-stage"]')).toBeNull();
    expect(pane.querySelector('img')).toBeNull();
    expect(pane.querySelector('[data-slot="photo-mosaic"][data-drawn]')).toBeNull();
    expect(within(pane).queryByRole('button', { name: /Show the photo/ })).toBeNull();
    expect(pane).toHaveTextContent(
      'Photos on flags are shown only to staff who can read hidden content',
    );
    // S does nothing for them.
    act(() => pane.focus());
    fireEvent.keyDown(pane, { key: 's', code: 'KeyS' });
    expect(pane.querySelector('img')).toBeNull();
    // The levers are the server's to grant: every flag verb is a moderator's, so none is drawn.
    expect(within(pane).queryByRole('toolbar')).toBeNull();
    expect(within(pane).queryByRole('button', { name: /^(Dismiss|Hide|Remove)/ })).toBeNull();
  });

  it('a purged photo says what was removed and when, with no image', () => {
    open(PHOTO_PURGED);
    mount();
    const pane = inspector();
    expect(pane.querySelector('img, canvas')).toBeNull();
    // The route draws dates in the runner's own zone (no board zone here): the same formatter, so
    // the check holds at either end of the date line.
    const purged = photoOf(PHOTO_PURGED);
    expect(pane).toHaveTextContent(
      `The file was deleted on ${dayMonth(must(purged.purgedAt, 'the purge time'))}`,
    );
    expect(pane).toHaveTextContent(
      `It was removed on ${dayMonth(must(purged.moderatedAt, 'the removal time'))}`,
    );
  });

  it('an uploader who has left is never named, and has no menu', () => {
    open(PHOTO_UPLOADER_GONE);
    mount();
    const pane = inspector();
    expect(pane).not.toHaveTextContent('Kate Donovan');
    expect(pane.querySelector('[data-bar-control="author"]')).toBeNull();
  });
});
