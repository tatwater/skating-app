import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinnerThird } from '@fortawesome/sharp-regular-svg-icons';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Dialog: shadcn's Base UI dialog, re-skinned to the console's modal.
 *
 * - **Square, on the panel ground**, with a `line2` edge and the modal shadow.
 * - **The scrim token behind, never a blur.** `scrim` for a dialog, `scrim-deep` for a viewer
 *   (a photo or a map opened large, inset `space-8` from every edge).
 * - **No close ×.** A dialog is dismissed by one of its own actions (`DialogClose` on a kit
 *   Button), by Esc, or by a press on the scrim.
 * - **A kicker-caps title**, then the words `space-1_5` under it. Header, body and foot pad by the
 *   surface's gutter, so the same dialog is denser on the console than on the skater app.
 * - **It fades, and only fades** — on the motion tokens, so reduced motion makes it instant. No
 *   zoom, no scale.
 * - **Scoped** when given a `container` (the inspector for an inset card, `main` for a task): the
 *   scrim and the dialog are positioned inside it instead of over the viewport.
 */

/** The fade every overlay part shares: opacity only, on a motion token. */
const FADE =
  'transition-opacity duration-(--duration-base) ease-standard data-starting-style:opacity-0 data-ending-style:opacity-0';

/** The edge, ground and type every dialog-like popup wears. */
const POPUP_FACE =
  'flex flex-col rounded-container border border-solid border-line2 bg-panel font-(family-name:--family-sans) text-fg shadow-modal outline-none';

/** Centered in the viewport (or its container), at the reason dialog's width, never past the gutter. */
const CENTERED = [
  'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2',
  'w-sheet-sm max-w-[calc(100%-2*var(--gap-gutter))] max-h-[calc(100%-2*var(--gap-gutter))]',
];

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/** Closes the dialog. Render it as an action: `<DialogClose render={<Button />}>Done</DialogClose>`. */
function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

type DialogContentProps = DialogPrimitive.Popup.Props &
  Pick<DialogPrimitive.Portal.Props, 'container'> & {
    /** `default`: centered at the reason dialog's width. `viewer`: inset from every edge. */
    size?: 'default' | 'viewer';
  };

function DialogContent({
  className,
  size = 'default',
  container,
  children,
  ...props
}: DialogContentProps) {
  // Inside a container the layers are positioned against it; the container must be positioned.
  const position = container != null ? 'absolute' : 'fixed';
  const viewer = size === 'viewer';
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Backdrop
        data-slot="dialog-scrim"
        className={cn(
          position,
          'inset-0',
          viewer ? 'z-(--z-viewer-scrim) bg-scrim-deep' : 'z-(--z-scrim) bg-scrim',
          FADE,
        )}
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-size={size}
        className={cn(
          position,
          POPUP_FACE,
          viewer ? 'inset-(--space-8) z-(--z-viewer)' : ['z-(--z-sheet)', ...CENTERED],
          FADE,
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/** The head: the title, then the words. Ruled from the body. */
function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        'flex shrink-0 flex-col gap-(--space-1_5) border-b border-solid border-line px-gutter py-(--space-4)',
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        'm-0 text-kick leading-none font-semibold tracking-kick text-fg uppercase',
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('m-0 text-assist leading-body font-regular text-fg2', className)}
      {...props}
    />
  );
}

type DialogBodyProps = ComponentProps<'div'> & {
  /**
   * Busy: the content keeps its place, unseen, under a spinner — so the dialog holds its final size
   * while what fills it loads. Pass placeholder content shaped like the real thing.
   */
  loading?: boolean;
};

/** The content. Scrolls on its own when it runs long, so the head and the foot stay put. */
function DialogBody({ className, loading = false, children, ...props }: DialogBodyProps) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        'relative flex min-h-0 flex-1 flex-col gap-(--space-3) overflow-y-auto px-gutter py-(--space-4)',
        'text-row leading-body text-fg1',
        className,
      )}
      {...props}
    >
      <OverlayBusy loading={loading}>{children}</OverlayBusy>
    </div>
  );
}

type DialogFooterProps = ComponentProps<'div'> & {
  /** A note at the left of the foot ("Press again within 3 s"); the actions sit right. */
  note?: ReactNode;
};

/** The foot: a ruled strip, a note left and the actions right — never a floating action bar. */
function DialogFooter({ className, note, children, ...props }: DialogFooterProps) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex shrink-0 items-center gap-(--space-2_5) border-t border-solid border-line px-gutter py-(--space-3)',
        className,
      )}
      {...props}
    >
      {note != null && (
        <span data-slot="dialog-note" className="text-assist leading-none text-fg3">
          {note}
        </span>
      )}
      <span className="ml-auto flex items-center gap-(--space-2_5)">{children}</span>
    </div>
  );
}

/**
 * Loading that reserves its size (the overlays' shared body): the content stays laid out but
 * unseen, a spinner over it, so nothing moves when the real content lands. Kit-internal.
 */
function OverlayBusy({ loading, children }: { loading: boolean; children?: ReactNode }) {
  return (
    <div data-slot="overlay-busy" aria-busy={loading || undefined} className="contents">
      <div
        data-slot="overlay-reserve"
        aria-hidden={loading || undefined}
        // `visibility` inherits through a `contents` box, so bare text hides too.
        className={cn('contents', loading && 'invisible')}
      >
        {children}
      </div>
      {loading && (
        <span
          data-slot="overlay-spinner"
          role="status"
          className="pointer-events-none absolute inset-0 grid place-items-center text-row text-fg2"
        >
          <FontAwesomeIcon icon={faSpinnerThird} className="h-[1.2em] motion-safe:animate-spin" />
          <span className="sr-only">Loading</span>
        </span>
      )}
    </div>
  );
}

export {
  CENTERED,
  Dialog,
  DialogBody,
  type DialogBodyProps,
  DialogClose,
  DialogContent,
  type DialogContentProps,
  DialogDescription,
  DialogFooter,
  type DialogFooterProps,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FADE,
  OverlayBusy,
  POPUP_FACE,
};
