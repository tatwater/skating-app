import { zIndex } from '@skating/design/tokens';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogReason,
  AlertDialogTitle,
} from './alert-dialog';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { createToastManager, Toaster, type ToastManager, toast } from './toast';

/**
 * **A refusal's toast over a modal dialog** (D268): a server's refusal arrives while a reason dialog
 * is open over the page, and must be seen and handled without closing the dialog or losing what was
 * typed in it. Drawn above the scrim, outside anything inert or hidden, reachable by keyboard (F6,
 * Base UI's), announced once, dismissed by its own *Dismiss* or Esc — the dialog staying open.
 */

beforeAll(() => {
  // jsdom has no Web Animations: the toast's motion asks for one it can play and finish.
  Element.prototype.animate = function animate() {
    return {
      cancel() {},
      pause() {},
      play() {},
      currentTime: 0,
      finished: Promise.resolve(),
    } as unknown as Animation;
  };
  if (!('getAnimations' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'getAnimations', { value: () => [] });
  }
});

/** A refusal as the one write helper says one: the failure's tone, held until dismissed. */
const refuse = (manager: ToastManager, title: string, description = 'Not allowed') =>
  act(() => {
    toast({ title, description, tone: 'bad', timeout: 0 }, manager);
  });

/** A page with a reason dialog open over it, and the app's dock. */
function Page({ manager }: { manager: ToastManager }) {
  const [open, setOpen] = useState(true);
  return (
    <Toaster manager={manager}>
      <button type="button">On the page</button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-slot="the-dialog">
          <AlertDialogTitle>Rule no public access?</AlertDialogTitle>
          <AlertDialogBody>
            <AlertDialogReason defaultValue="" />
          </AlertDialogBody>
          <AlertDialogCancel />
        </AlertDialogContent>
      </AlertDialog>
    </Toaster>
  );
}

const theToast = () => document.querySelector<HTMLElement>('[data-slot="toast"]');
const theDialog = () => document.querySelector<HTMLElement>('[data-slot="the-dialog"]');

describe('a refusal toast over a modal dialog', () => {
  it('stacks above every overlay: the scrim, a sheet and a viewer', () => {
    expect(zIndex.toast).toBeGreaterThan(zIndex.scrim);
    expect(zIndex.toast).toBeGreaterThan(zIndex.sheet);
    expect(zIndex.toast).toBeGreaterThan(zIndex.viewer);
  });

  it('is drawn outside anything inert or hidden, while the dialog hides the page', async () => {
    const manager = createToastManager();
    render(<Page manager={manager} />);
    await waitFor(() => expect(theDialog()).not.toBeNull());
    refuse(manager, 'Not saved · Mascoma Lake');
    const viewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
    await waitFor(() => expect(theToast()).not.toBeNull());
    // The dialog marks the page beneath it; never the dock.
    expect(viewport?.closest('[inert]')).toBeNull();
    expect(viewport?.closest('[aria-hidden="true"]')).toBeNull();
    expect(viewport?.closest('[hidden]')).toBeNull();
  });

  it('is announced once, as it arrives', async () => {
    const manager = createToastManager();
    render(<Page manager={manager} />);
    refuse(manager, 'Not saved · Mascoma Lake', 'The ruling: Not allowed');
    await waitFor(() => expect(theToast()).not.toBeNull());
    const alerts = [...document.querySelectorAll('[role="alert"]')].filter((a) =>
      a.textContent?.includes('The ruling: Not allowed'),
    );
    expect(alerts).toHaveLength(1);
  });

  it('is reached by keyboard from inside the dialog (F6), and dismissed there, the dialog kept with its reason', async () => {
    const manager = createToastManager();
    const user = userEvent.setup();
    render(<Page manager={manager} />);
    const reason = await screen.findByRole('textbox');
    await user.type(reason, 'Posted all round');
    refuse(manager, 'Not saved · Mascoma Lake');
    await waitFor(() => expect(theToast()).not.toBeNull());
    expect(reason).toHaveFocus();
    await user.keyboard('{F6}');
    expect(document.querySelector('[data-slot="toast-viewport"]')).toHaveFocus();
    await user.tab();
    expect(theToast()).toHaveFocus();
    await user.tab();
    expect(document.activeElement).toHaveAttribute('data-slot', 'toast-dismiss');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(theToast()).toBeNull());
    expect(theDialog()).not.toBeNull();
    expect(within(theDialog() as HTMLElement).getByRole('textbox')).toHaveValue('Posted all round');
  });

  it('Esc inside the toast closes the toast alone — never the dialog under it', async () => {
    const manager = createToastManager();
    const user = userEvent.setup();
    render(<Page manager={manager} />);
    const reason = await screen.findByRole('textbox');
    await user.type(reason, 'Posted all round');
    refuse(manager, 'Not saved · Mascoma Lake');
    await waitFor(() => expect(theToast()).not.toBeNull());
    await user.keyboard('{F6}');
    await user.tab();
    expect(theToast()).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(theToast()).toBeNull());
    expect(theDialog()).not.toBeNull();
    expect(within(theDialog() as HTMLElement).getByRole('textbox')).toHaveValue('Posted all round');
  });

  it('a pointer on Dismiss closes the toast, never the dialog', async () => {
    const manager = createToastManager();
    const user = userEvent.setup();
    render(<Page manager={manager} />);
    await screen.findByRole('textbox');
    refuse(manager, 'Not saved · Mascoma Lake');
    await waitFor(() => expect(theToast()).not.toBeNull());
    await user.click(theToast()?.querySelector('[data-slot="toast-dismiss"]') as HTMLElement);
    await waitFor(() => expect(theToast()).toBeNull());
    expect(theDialog()).not.toBeNull();
  });
});

describe('a popup opened under a refusal', () => {
  it('draws above the toast: a menu the operator just opened is never covered by one that waits', async () => {
    const manager = createToastManager();
    const user = userEvent.setup();
    render(
      <Toaster manager={manager}>
        <Popover>
          <PopoverTrigger>Open</PopoverTrigger>
          <PopoverContent>The choices</PopoverContent>
        </Popover>
      </Toaster>,
    );
    refuse(manager, 'Not saved · Mascoma Lake');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const popup = await screen.findByText('The choices');
    // The popup's positioner sits one above the toast's layer; the dock is on the toast's own.
    const positioner = popup.closest('[class*="z-["]') as HTMLElement;
    expect(positioner.className).toContain('z-[calc(var(--z-toast)+1)]');
    expect(document.querySelector('[data-slot="toast-viewport"]')?.className).toContain(
      'z-(--z-toast)',
    );
  });
});

describe('several refusals at once', () => {
  it('draw one plate at a time and lose none: each shows once the one in front is dismissed', async () => {
    const manager = createToastManager();
    const user = userEvent.setup();
    render(<Toaster manager={manager} />);
    for (const n of [1, 2, 3, 4, 5]) refuse(manager, `Not saved · Lake ${n}`);
    // One plate drawn, the newest; the rest wait behind it, inert and unseen, never dropped.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(5));
    const shown = () =>
      [...document.querySelectorAll<HTMLElement>('[data-slot="toast"]')].filter(
        (t) => !t.hasAttribute('data-limited'),
      );
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toHaveTextContent('Not saved · Lake 5');
    for (const n of [5, 4, 3, 2, 1]) {
      const front = shown()[0] as HTMLElement;
      expect(front).toHaveTextContent(`Not saved · Lake ${n}`);
      await user.click(front.querySelector('[data-slot="toast-dismiss"]') as HTMLElement);
      await waitFor(() => expect(document.body).not.toHaveTextContent(`Not saved · Lake ${n}Not`));
      await waitFor(() =>
        expect(
          [...document.querySelectorAll('[data-slot="toast"]')].some((t) =>
            t.textContent?.includes(`Lake ${n}`),
          ),
        ).toBe(false),
      );
    }
    expect(document.querySelector('[data-slot="toast"]')).toBeNull();
  });

  it('a receipt in front of a refusal times out, and the refusal is drawn again', async () => {
    const manager = createToastManager();
    render(<Toaster manager={manager} />);
    refuse(manager, 'Not saved · Mascoma Lake');
    act(() => {
      toast({ title: 'Links saved · Crystal Lake', tone: 'lit', timeout: 20 }, manager);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]:not([data-limited])')).toHaveTextContent(
        'Links saved',
      ),
    );
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toast"]:not([data-limited])')).toHaveTextContent(
        'Not saved · Mascoma Lake',
      ),
    );
  });
});
