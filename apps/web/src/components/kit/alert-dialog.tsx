import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';
import {
  CENTERED,
  DialogBody,
  DialogFooter,
  type DialogFooterProps,
  FADE,
  POPUP_FACE,
} from './dialog';
import { Kbd } from './kbd';

/**
 * The kit's AlertDialog: shadcn's Base UI alert dialog, re-skinned to **the reason dialog** — the
 * one dialog every action that takes something away goes through.
 *
 * - **A question for a title** ("Hide this report?"), sentence case, then what happens; a press on
 *   the scrim never dismisses it (Esc and Cancel do). No blur, no ×, no zoom: it fades.
 * - **A reason only when something is taken away** (hide, remove, demote, suspend). Restoring or
 *   approving asks nothing — that is no dialog at all, so this component has no "optional reason".
 *   `AlertDialogReason` is the boxed field; the action `waits` (inert) until it holds something.
 * - **Never red at rest.** A `destructive` action rests like any outlined action. The first press
 *   *arms* it (red label and dots, "· again", and the foot says "Press again within 3 s"); only a
 *   second press inside the window acts. The window lapses back to rest on its own.
 * - **⌘⏎ (or Ctrl+⏎) confirms** from anywhere in the dialog — it presses the action, so a
 *   destructive one still takes two, and a waiting one takes none.
 * - **The server can say no**: `AlertDialogError` holds the refusal (what changed under you) over
 *   the reason, which is kept.
 */

/** How long an armed destructive action waits for its second press. */
const ARM_WINDOW_MS = 3000;

type ArmState = { armed: boolean; setArmed: (armed: boolean) => void };
// The default only serves an action rendered outside `AlertDialogContent` — a misuse, not a case
// worth a test.
/* v8 ignore next */
const Arm = createContext<ArmState>({ armed: false, setArmed: () => {} });

function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

type AlertDialogContentProps = AlertDialogPrimitive.Popup.Props &
  Pick<AlertDialogPrimitive.Portal.Props, 'container'>;

function AlertDialogContent({
  className,
  container,
  onKeyDown,
  children,
  ...props
}: AlertDialogContentProps) {
  const position = container != null ? 'absolute' : 'fixed';
  return (
    <AlertDialogPrimitive.Portal container={container}>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-scrim"
        className={cn(position, 'inset-0 z-(--z-scrim) bg-scrim', FADE)}
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(position, POPUP_FACE, 'z-(--z-sheet)', CENTERED, FADE, className)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
          event.preventDefault();
          event.currentTarget
            .querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')
            ?.click();
        }}
        {...props}
      >
        <ArmScope>{children}</ArmScope>
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}

/**
 * The armed state, held inside the popup: `AlertDialogContent` itself stays mounted while the
 * dialog is closed, but the popup's subtree unmounts — so a cancelled, armed action can't survive
 * into the next open, and a reopened dialog always starts at rest.
 */
function ArmScope({ children }: { children: ReactNode }) {
  const [armed, setArmed] = useState(false);
  return <Arm.Provider value={{ armed, setArmed }}>{children}</Arm.Provider>;
}

/** The head: the question, then what happens. Ruled from the body. */
function AlertDialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        'flex shrink-0 flex-col gap-(--space-1_5) border-b border-solid border-line px-gutter py-(--space-4)',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('m-0 text-body leading-(--lead-snug) font-semibold text-fg', className)}
      {...props}
    />
  );
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('m-0 text-assist leading-body font-regular text-fg2', className)}
      {...props}
    />
  );
}

/** The body: the reason, any extra fields, a refusal. Reserves its size while it loads. */
const AlertDialogBody = DialogBody;

/** The foot. While the action is armed, its note says how to finish. */
function AlertDialogFooter({ note, ...props }: DialogFooterProps) {
  const { armed } = useContext(Arm);
  return <DialogFooter note={armed ? 'Press again within 3 s' : note} {...props} />;
}

/** Closes without acting. */
function AlertDialogCancel({ children = 'Cancel', ...props }: ButtonProps) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      render={<Button variant="outline" {...props} />}
    >
      {children}
    </AlertDialogPrimitive.Close>
  );
}

type AlertDialogActionProps = Omit<ButtonProps, 'variant' | 'armed'> & {
  /** Takes something away for good: rests outlined, arms red on the first press, acts on the second. */
  destructive?: boolean;
  /** Inert until the dialog has what it needs (a reason, a typed word). */
  waiting?: boolean;
  /** The armed window, in ms. */
  armFor?: number;
};

/**
 * The one action. Not a close: it calls `onClick` and the caller closes the dialog when the work
 * lands — or keeps it open with an `AlertDialogError` when the server refuses.
 */
function AlertDialogAction({
  destructive = false,
  waiting = false,
  armFor = ARM_WINDOW_MS,
  disabled,
  onClick,
  children,
  ...props
}: AlertDialogActionProps) {
  const { armed, setArmed } = useContext(Arm);
  const isArmed = destructive && armed;
  const inert = waiting || disabled === true;

  useEffect(() => {
    if (!isArmed) return;
    const lapse = setTimeout(() => setArmed(false), armFor);
    return () => clearTimeout(lapse);
  }, [isArmed, armFor, setArmed]);

  // Something it waits for went away (the reason was cleared): an armed press doesn't survive it.
  useEffect(() => {
    if (inert) setArmed(false);
  }, [inert, setArmed]);

  return (
    <Button
      data-slot="alert-dialog-action"
      variant={destructive ? 'danger' : 'primary'}
      armed={isArmed}
      disabled={inert}
      aria-keyshortcuts="Meta+Enter Control+Enter"
      onClick={(event) => {
        if (destructive && !armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onClick?.(event);
      }}
      {...props}
    >
      {children}
      {isArmed ? (
        <span data-slot="alert-dialog-again"> · again</span>
      ) : (
        <Kbd variant="dim" aria-hidden="true" disabled={inert}>
          ⌘⏎
        </Kbd>
      )}
    </Button>
  );
}

type AlertDialogReasonProps = Omit<ComponentProps<'textarea'>, 'children'> & {
  /** The kicker over the box: "Reason", or who will read it ("Reason · audit log and the author"). */
  label?: ReactNode;
};

/**
 * The boxed reason field. Focus brightens its edge to `fg2` — never the bright ink; a refused or
 * invalid reason (`aria-invalid`) edges in red.
 */
function AlertDialogReason({
  label = 'Reason',
  id,
  className,
  placeholder = 'Why?',
  ...props
}: AlertDialogReasonProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <div data-slot="alert-dialog-reason" className="flex flex-col gap-(--space-2)">
      <label
        htmlFor={fieldId}
        className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase"
      >
        {label}
      </label>
      <textarea
        id={fieldId}
        placeholder={placeholder}
        className={cn(
          'block min-h-[4rem] w-full resize-y rounded-none border border-solid border-line2 bg-bg',
          'px-(--space-2_5) py-(--space-2) font-(family-name:--family-sans) text-row leading-body text-fg',
          'outline-none placeholder:text-fg3',
          'transition-[border-color] duration-(--duration-fast) ease-standard',
          '[@media(hover:hover)]:hover:border-fg3 focus:border-fg2 focus:hover:border-fg2',
          'aria-invalid:border-bad aria-invalid:hover:border-bad',
          'disabled:cursor-default disabled:border-line disabled:text-fg-disabled',
          className,
        )}
        {...props}
      />
    </div>
  );
}

type AlertDialogErrorProps = ComponentProps<'div'> & {
  /** The lead, in red ("Not saved."). */
  title?: ReactNode;
};

/** The server said no: a red rule at the left, the lead in red, then what changed and what to do. */
function AlertDialogError({
  className,
  title = 'Not saved.',
  children,
  ...props
}: AlertDialogErrorProps) {
  return (
    <div
      data-slot="alert-dialog-error"
      role="alert"
      className={cn(
        'border-0 border-l-(length:--stroke-note) border-solid border-bad px-(--space-2_5) py-(--space-1)',
        'text-assist leading-body text-fg1',
        className,
      )}
      {...props}
    >
      <b className="font-medium text-bad">{title}</b> {children}
    </div>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  type AlertDialogActionProps,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  type AlertDialogContentProps,
  AlertDialogDescription,
  AlertDialogError,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogReason,
  type AlertDialogReasonProps,
  AlertDialogTitle,
  AlertDialogTrigger,
  ARM_WINDOW_MS,
};
