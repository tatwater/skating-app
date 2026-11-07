import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactNode, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogError,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogReason,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog';
import { Button } from './button';
import { Dialog } from './dialog';
import { Field, FieldLabel, Input } from './input';
import { computedColor, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { must } from './storyKit';

const meta = {
  title: 'Kit/AlertDialog',
  component: AlertDialog,
  tags: ['autodocs'],
} satisfies Meta<typeof AlertDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const popup = (root: ParentNode = document) =>
  root.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
const scrim = () => document.querySelector<HTMLElement>('[data-slot="alert-dialog-scrim"]');
const part = (root: Element, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));
const action = (dialog: HTMLElement) => part(dialog, 'alert-dialog-action');

/** What the confirm handlers below received, for the stories to check. */
const confirmed = fn();

type ReasonDialogProps = {
  trigger: string;
  title: string;
  description: string;
  verb: string;
  destructive?: boolean;
  defaultReason?: string;
  defaultOpen?: boolean;
  armFor?: number;
  modal?: boolean;
  container?: HTMLElement | null;
  /** Extra fields over the reason, and whether they're complete. */
  extra?: (ready: (ok: boolean) => void) => ReactNode;
  error?: ReactNode;
};

/** The reason dialog as the console uses it: a question, a reason, Cancel and the one action. */
function ReasonDialog({
  trigger,
  title,
  description,
  verb,
  destructive,
  defaultReason = '',
  defaultOpen,
  armFor,
  container,
  extra,
  error,
}: ReasonDialogProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [reason, setReason] = useState(defaultReason);
  const [extraReady, setExtraReady] = useState(extra === undefined);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant={destructive ? 'danger' : 'outline'} />}>
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent container={container}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody>
          {error}
          {extra?.(setExtraReady)}
          <AlertDialogReason
            label="Reason · audit log and the author"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            destructive={destructive}
            armFor={armFor}
            waiting={reason.trim() === '' || !extraReady}
            onClick={() => {
              confirmed(reason);
              setOpen(false);
            }}
          >
            {verb}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const HIDE = {
  trigger: 'Hide',
  title: 'Hide this report?',
  description:
    'It leaves every public surface. The author still sees it, with your reason. Undo from the toast or History.',
  verb: 'Hide',
} as const;

const REMOVE = {
  trigger: 'Remove',
  title: 'Remove this report?',
  description:
    'Removed reports leave storage after 30 days unless restored. This one has 3 photos and 2 comments.',
  verb: 'Remove',
  destructive: true,
  defaultReason: 'Duplicate of the 4 Oct report, same photos.',
} as const;

/**
 * A reason, required. The action waits (inert) until the reason holds something; the box brightens
 * to `fg2` on focus, never the bright ink. A press on the scrim doesn't dismiss it; ⌘⏎ confirms.
 */
export const ReasonRequired: Story = {
  render: () => <ReasonDialog {...HIDE} />,
  beforeEach: () => confirmed.mockClear(),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Hide' }));
    const dialog = await waitFor(() => must(popup()));
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    await expect(dialog).toHaveAccessibleName('Hide this report?');
    await expect(action(dialog)).toBeDisabled();
    await expect(action(dialog)).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter');
    // No ×: Cancel and the action are the only ways out, besides Esc.
    await expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Cancel', 'Hide⌘⏎']);

    const box = within(dialog).getByRole('textbox', { name: /Reason/ });
    await userEvent.click(box);
    // Resolved outside `waitFor`: the probe it appends is a mutation, which would re-run the
    // callback forever.
    const focusEdge = computedColor(box, 'var(--fg2)');
    await waitFor(() => expect(getComputedStyle(box).borderTopColor).toBe(focusEdge));
    await expect(getComputedStyle(box).borderTopColor).not.toBe(computedColor(box, 'var(--fg)'));
    await expect(getComputedStyle(box).borderRadius).toBe('0px');

    // ⌘⏎ on a waiting action does nothing.
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await expect(confirmed).not.toHaveBeenCalled();

    await userEvent.type(box, 'Same claim as the hidden 4 Oct report.');
    await expect(action(dialog)).toBeEnabled();

    // The scrim doesn't dismiss a reason dialog.
    await userEvent.click(must(scrim()));
    await expect(popup()).not.toBeNull();

    // From anywhere inside the dialog (Ctrl for a keyboard without ⌘).
    await userEvent.click(box);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await expect(confirmed).toHaveBeenCalledWith('Same claim as the hidden 4 Oct report.');
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/** Esc and Cancel close it without acting. */
export const Dismiss: Story = {
  render: () => <ReasonDialog {...HIDE} />,
  beforeEach: () => confirmed.mockClear(),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Hide' });
    await userEvent.click(trigger);
    await waitFor(() => expect(popup()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(popup()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    await userEvent.click(trigger);
    await userEvent.click(within(must(popup())).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(popup()).toBeNull());
    await expect(confirmed).not.toHaveBeenCalled();
  },
};

/**
 * Destructive: never red at rest. The first press arms it — red label and dots, "· again", and the
 * foot says how to finish; the second press acts.
 */
export const DestructiveTwoPress: Story = {
  render: () => <ReasonDialog {...REMOVE} defaultOpen />,
  beforeEach: () => confirmed.mockClear(),
  play: async () => {
    const dialog = await waitFor(() => must(popup()));
    const remove = action(dialog);
    await expect(remove).toBeEnabled();
    await expect(remove).not.toHaveAttribute('data-armed');
    const bad = computedColor(remove, 'var(--bad)');
    await expect(getComputedStyle(remove).color).not.toBe(bad);
    await expect(dialog.querySelector('[data-slot="dialog-note"]')).toBeNull();

    await userEvent.click(remove);
    await expect(confirmed).not.toHaveBeenCalled();
    await expect(remove).toHaveAttribute('data-armed');
    await expect(remove).toHaveTextContent('Remove · again');
    await waitFor(() => expect(getComputedStyle(remove).color).toBe(bad));
    await expect(part(dialog, 'dialog-note')).toHaveTextContent('Press again within 3 s');

    await userEvent.click(remove);
    await expect(confirmed).toHaveBeenCalledWith(REMOVE.defaultReason);
    await waitFor(() => expect(popup()).toBeNull());
  },
};

/** The armed window lapses on its own, and clearing the reason disarms at once. */
export const ArmLapses: Story = {
  render: () => <ReasonDialog {...REMOVE} defaultOpen armFor={300} />,
  beforeEach: () => confirmed.mockClear(),
  play: async () => {
    const dialog = await waitFor(() => must(popup()));
    const remove = action(dialog);
    await userEvent.click(remove);
    await expect(remove).toHaveAttribute('data-armed');
    await waitFor(() => expect(remove).not.toHaveAttribute('data-armed'), { timeout: 2000 });
    await expect(dialog.querySelector('[data-slot="dialog-note"]')).toBeNull();

    await userEvent.click(remove);
    await expect(remove).toHaveAttribute('data-armed');
    await userEvent.clear(within(dialog).getByRole('textbox'));
    await expect(remove).not.toHaveAttribute('data-armed');
    await expect(remove).toBeDisabled();
    await expect(confirmed).not.toHaveBeenCalled();
  },
};

/** Typed confirmation, for what resets a season: the action waits for the word and the reason. */
export const TypedConfirmation: Story = {
  render: () => (
    <ReasonDialog
      trigger="Reset"
      title="Reset this watch?"
      description="Winter 2026–27 is re-detected from tonight with settings v4. The old record is kept as superseded and the staff emails don't resend."
      verb="Reset the watch"
      defaultReason="Thresholds tuned with Matt; v3 opened the watch a week early."
      defaultOpen
      extra={(ready) => (
        <Field>
          <FieldLabel>Type reset to confirm</FieldLabel>
          <Input autoComplete="off" onChange={(e) => ready(e.target.value === 'reset')} />
        </Field>
      )}
    />
  ),
  beforeEach: () => confirmed.mockClear(),
  play: async () => {
    const dialog = await waitFor(() => must(popup()));
    const word = within(dialog).getByRole('textbox', { name: 'Type reset to confirm' });
    await userEvent.type(word, 'rese');
    await expect(action(dialog)).toBeDisabled();
    await userEvent.type(word, 't');
    await expect(action(dialog)).toBeEnabled();
  },
};

/** The server said no: the refusal leads the body, a red rule at its left; the reason is kept. */
export const ServerRefused: Story = {
  render: () => (
    <ReasonDialog
      trigger="Take off the map"
      title="Take Mascoma Lake off the map?"
      description="Landowner request."
      verb="Try again"
      defaultReason="Owner asked by email, 12 Oct."
      defaultOpen
      error={
        <AlertDialogError>
          Sarah set Mascoma Lake dormant at 14:41, after you opened this. Look at her note, then try
          again or undo hers.
        </AlertDialogError>
      }
    />
  ),
  play: async () => {
    const dialog = await waitFor(() => must(popup()));
    const error = within(dialog).getByRole('alert');
    await expect(error).toHaveTextContent(/^Not saved\. Sarah set/);
    const style = getComputedStyle(error);
    await expect(style.borderLeftColor).toBe(computedColor(error, 'var(--bad)'));
    await expect(parseFloat(style.borderLeftWidth)).toBe(resolvePx(error, 'var(--stroke-note)'));
    await expect(style.borderTopWidth).toBe('0px');
    await expect(within(dialog).getByRole('textbox')).toHaveValue('Owner asked by email, 12 Oct.');
  },
};

/**
 * The junctions: head, body and foot pad by the gutter; the question sits `space-1_5` over the
 * words; the reason's kicker `space-2` over its box. The scrim is the token, no blur.
 */
export const JunctionOpen: Story = {
  render: () => <ReasonDialog {...HIDE} defaultOpen />,
  play: async () => {
    const dialog = await waitFor(() => must(popup()));
    await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe('1'));
    const near = (a: number, b: number) =>
      expect(Math.abs(a - b)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    const box = dialog.getBoundingClientRect();
    const edge = resolvePx(dialog, 'var(--stroke-hair)');
    const gutter = resolvePx(dialog, 'var(--gap-gutter)');
    const title = part(dialog, 'alert-dialog-title').getBoundingClientRect();
    const words = part(dialog, 'alert-dialog-description').getBoundingClientRect();
    await near(title.left - box.left - edge, gutter);
    await near(words.top - title.bottom, resolvePx(dialog, 'var(--space-1_5)'));
    const reason = part(dialog, 'alert-dialog-reason');
    const label = must(reason.querySelector('label')).getBoundingClientRect();
    const field = must(reason.querySelector('textarea')).getBoundingClientRect();
    await near(field.top - label.bottom, resolvePx(dialog, 'var(--space-2)'));
    await near(field.left - box.left - edge, gutter);
    await near(box.right - edge - action(dialog).getBoundingClientRect().right, gutter);
    // The question is sentence case, not a kicker.
    await expect(getComputedStyle(part(dialog, 'alert-dialog-title')).textTransform).toBe('none');
    const dim = must(scrim());
    await expect(getComputedStyle(dim).backgroundColor).toBe(computedColor(dim, 'var(--scrim)'));
    await expect(getComputedStyle(dim).backdropFilter).toBe('none');
  },
};

/**
 * Four modal alert dialogs open at once would trap focus against each other, forever. The four-up
 * only shows the face, so each quad mounts the same content under a non-modal Dialog root (an
 * alert dialog's parts are Base UI's dialog parts).
 */
function QuadReason(): ReactNode {
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  return (
    <div ref={setFrame} className="relative h-[26rem]">
      {frame !== null && (
        <Dialog open modal={false}>
          <AlertDialogContent container={frame}>
            <AlertDialogHeader>
              <AlertDialogTitle>{REMOVE.title}</AlertDialogTitle>
              <AlertDialogDescription>{REMOVE.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogBody>
              <AlertDialogReason defaultValue={REMOVE.defaultReason} />
            </AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogCancel />
              <AlertDialogAction destructive>{REMOVE.verb}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** Open in all four maps: the console's is denser, and the armed red is each map's own. */
export const FourUp: Story = {
  render: () => <QuadReason />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const sizes: Record<string, number[]> = { admin: [], skater: [] };
    for (const q of quads) {
      const dialog = await waitFor(() => must(popup(q)));
      sizes[must(q.dataset.surface)]?.push(
        parseFloat(getComputedStyle(part(dialog, 'alert-dialog-title')).fontSize),
      );
    }
    await expect(Math.max(...(sizes.admin ?? []))).toBeLessThan(Math.min(...(sizes.skater ?? [])));
  },
};
