import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { AUDIT_REASON_MAX } from '@skating/core';
import { useConvex } from 'convex/react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogReason,
  AlertDialogTitle,
} from '@/components/kit/alert-dialog';
import { type ToastManager, toast, toastManager } from '@/components/kit/toast';
import { said, sayRefusal } from '../said';
import type { AuditTarget } from './actionLabels';

/**
 * Undo in the console (D226): every operator action undoes from its toast for ten seconds, and from
 * History after that. The server decides everything — whether a row can still be undone, whether
 * the undo needs a reason, and "a later write means no undo" — so this is only the receipts and
 * the one question:
 *
 * - **`announce`**, after an action lands: shows the receipt toast, with Undo (⌘Z) while the server
 *   offers one. A write that answered with its own audit row and whether undoing it asks a reason
 *   needs nothing more; otherwise the toast asks the server for the caller's own newest action on
 *   the target (`undo.latestOwn`) first; a write that said it can't be undone now (`undoable:
 *   false`) gets its receipt with no Undo and no lookup. Undo is never drawn when the server would
 *   refuse it.
 * - **`undo`**, from the toast or a History row: runs `undo.run`. When the undo takes something
 *   away from skaters it asks the reason first, in the reason dialog; restoring asks nothing.
 * - **A refusal is the server's own words, in a toast** ("Not undone", D268) that stays until it
 *   is dismissed. Someone acted on the same thing since, the row was already undone, the role isn't
 *   held: the message the server wrote is what the operator reads. The reason dialog stays open over
 *   the kept reason, to correct and send again.
 *
 * Mounted once, in the console's shell (`ConsoleLayout`).
 */

export type UndoTarget = { targetType: AuditTarget; targetId: string };

/** An undo's refusal, its title: the server's words follow it. */
const NOT_UNDONE = 'Not undone';

export type Receipt = {
  /** What was done, from the operator's side ("Hidden · “Black ice at the beach”"). */
  title: ReactNode;
  /** The consequence or the next step. */
  description?: ReactNode;
  /** What it was done to: where the server looks for the caller's action to undo. */
  target: UndoTarget;
  /**
   * The write's own audit row, when the write answered with it — then the toast needs no lookup:
   * the row is the caller's newest on the target by construction. Used only together with
   * {@link Receipt.undoNeedsReason}; a row without it falls back to the lookup, which says both —
   * unless {@link Receipt.undoable} is `false`, which offers no Undo and looks nothing up.
   */
  actionId?: string;
  /** Whether undoing the write takes something away from skaters (and so asks why). */
  undoNeedsReason?: boolean;
  /**
   * `false` when the write itself said it can't be undone now (`undoable: false`): the receipt
   * shows with no Undo, and nothing is looked up.
   */
  undoable?: false;
  /**
   * Whose it is, by name ("Mascoma Lake"), set after the title ("Links saved · Mascoma Lake"):
   * a receipt that may show over another page names its subject, so its Undo is never ambiguous —
   * as the People receipts name their person.
   */
  subject?: string;
};

type UndoRequest = {
  actionId: string;
  /** The undo takes something away from skaters, so it asks why. */
  needsReason: boolean;
  /** What is being undone, for the dialog's question. */
  what?: ReactNode;
};

type UndoApi = {
  /**
   * `here`, when given, is the caller's binding (the Body console's `currentBody`): asked again
   * once the server has answered, so a receipt whose console went away during that round trip
   * never shows over the next one (History keeps the row).
   */
  announce: (receipt: Receipt, here?: () => boolean) => Promise<void>;
  undo: (request: UndoRequest) => void;
};

const UndoContext = createContext<UndoApi | null>(null);

/** The console's undo. Throws outside `UndoProvider`. */
export function useUndo(): UndoApi {
  const api = useContext(UndoContext);
  if (api === null) throw new Error('useUndo needs an <UndoProvider> above it.');
  return api;
}

/** The two server calls undo makes, as the provider needs them (a story or a test fakes them). */
export type UndoServer = {
  latestOwn: (
    target: UndoTarget,
  ) => Promise<{ actionId: string; undo: { state: string; needsReason?: boolean } } | null>;
  run: (args: { actionId: string; reason?: string }) => Promise<void>;
};

/** The real server: Convex's `undo.latestOwn` and `undo.run`. */
export function useUndoServer(): UndoServer {
  const convex = useConvex();
  return useMemo(
    () => ({
      latestOwn: (target) => convex.query(api.undo.latestOwn, target),
      run: async ({ actionId, reason }) => {
        await convex.mutation(api.undo.run, {
          actionId: actionId as Id<'moderationActions'>,
          ...(reason !== undefined ? { reason } : {}),
        });
      },
    }),
    [convex],
  );
}

export function UndoProvider({
  server,
  manager = toastManager,
  children,
}: {
  server: UndoServer;
  /** The toast queue; the app's own unless a story or a test passes one. */
  manager?: ToastManager;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState<UndoRequest | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Whether this provider — and so its reason dialog — is there to ask: a receipt outlives the
  // console in the app's one dock, and its Undo can be pressed after the console has gone.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (actionId: string, why?: string): Promise<boolean> => {
      const sent = await said(
        () => server.run({ actionId, ...(why !== undefined ? { reason: why } : {}) }),
        (words) => ({ title: NOT_UNDONE, description: words }),
        { manager },
      );
      if (sent.landed) {
        toast(
          { title: 'Undone', description: 'Both rows stay in the audit log', tone: 'lit' },
          manager,
        );
      }
      return sent.landed;
    },
    [server, manager],
  );

  const undo = useCallback(
    (request: UndoRequest) => {
      if (request.needsReason) {
        // A receipt outlives the console in the app's one dock: pressed after the console has gone,
        // its reason dialog has nowhere to open — say so, never a press that does nothing.
        if (!mounted.current) {
          sayRefusal(
            {
              title: NOT_UNDONE,
              description: 'Undoing it needs a reason: undo it from History in the console',
            },
            manager,
          );
          return;
        }
        setReason('');
        setAsking(request);
        return;
      }
      void run(request.actionId);
    },
    [run, manager],
  );

  const announce = useCallback(
    async (
      { title: done, description, target, actionId, undoNeedsReason, undoable, subject }: Receipt,
      here?: () => boolean,
    ) => {
      // A receipt that may show over another page names its subject ("Links saved · Mascoma Lake").
      const title =
        subject === undefined ? (
          done
        ) : (
          <>
            {done} · {subject}
          </>
        );
      let offered: { actionId: string; undo: { needsReason?: boolean } } | null = null;
      if (undoable === false) {
        // The write said so: no Undo to offer, and no lookup that could disagree with it.
        offered = null;
      } else if (actionId !== undefined && undoNeedsReason !== undefined) {
        // The write named its own row and what undoing it asks: no lookup. Were someone to act on
        // the same thing in the moment between, the undo's run refuses in the server's own words.
        offered = { actionId, undo: { needsReason: undoNeedsReason } };
      } else {
        let latest: Awaited<ReturnType<UndoServer['latestOwn']>> = null;
        try {
          latest = await server.latestOwn(target);
        } catch {
          // The receipt still shows; only its Undo is left off (History keeps the row).
        }
        // Another staffer acting on it since leaves the caller's row overtaken: no Undo.
        offered = latest !== null && latest.undo.state === 'available' ? latest : null;
      }
      // The console that asked for the receipt has gone (after the lookup's round trip, or before
      // a write's own row came back): no receipt over whatever stands there now.
      if (here !== undefined && !here()) return;
      toast(
        {
          title,
          ...(description !== undefined ? { description } : {}),
          tone: 'lit',
          ...(offered !== null
            ? {
                action: {
                  label: 'Undo',
                  kbd: '⌘Z',
                  onAction: () =>
                    undo({
                      actionId: offered.actionId,
                      needsReason: offered.undo.needsReason === true,
                      what: title,
                    }),
                },
              }
            : {}),
        },
        manager,
      );
    },
    [server, manager, undo],
  );

  const value = useMemo(() => ({ announce, undo }), [announce, undo]);
  const trimmed = reason.trim();

  return (
    <UndoContext.Provider value={value}>
      {children}
      <AlertDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAsking(null);
        }}
      >
        <AlertDialogContent data-slot="undo-reason-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this?</AlertDialogTitle>
            <AlertDialogDescription>
              {asking?.what !== undefined && (
                <>
                  {asking.what}
                  {'. '}
                </>
              )}
              Undoing it takes something away from skaters, so it needs a reason. Both rows stay in
              the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            {/* A sent reason is held while the undo is out (it lands once, closing the dialog). */}
            <AlertDialogReason
              value={reason}
              // An undo's reason is its audit row's (D261).
              maxLength={AUDIT_REASON_MAX}
              readOnly={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <AlertDialogAction
              waiting={trimmed.length === 0 || busy}
              onClick={() => {
                const request = asking;
                if (request === null) return;
                setBusy(true);
                // Refused: said in its toast; the dialog stays open over the kept reason.
                void run(request.actionId, trimmed).then((landed) => {
                  setBusy(false);
                  if (landed) setAsking(null);
                });
              }}
            >
              Undo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UndoContext.Provider>
  );
}
