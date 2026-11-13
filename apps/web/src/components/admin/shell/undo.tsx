import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useConvex } from 'convex/react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
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
} from '@/components/kit/alert-dialog';
import { type ToastManager, toast, toastManager } from '@/components/kit/toast';
import { errorText } from '../adminUi';
import type { AuditTarget } from './actionLabels';

/**
 * Undo in the console (D226): every operator action undoes from its toast for ten seconds, and from
 * History after that. The server decides everything — whether a row can still be undone, whether
 * the undo needs a reason, and "a later write means no undo" — so this is only the receipts and
 * the one question:
 *
 * - **`announce`**, after an action lands: asks the server for the caller's own newest action on
 *   the target (`undo.latestOwn`) and shows the receipt toast, with Undo (⌘Z) while the server
 *   offers one. Undo is never drawn when the server would refuse it.
 * - **`undo`**, from the toast or a History row: runs `undo.run`. When the undo takes something
 *   away from skaters it asks the reason first, in the reason dialog; restoring asks nothing.
 * - **A refusal is the server's own words.** Someone acted on the same thing since, the row was
 *   already undone, the role isn't held: the message the server wrote is what the operator reads
 *   (a red toast, or the dialog's error over the kept reason).
 *
 * Mounted once, in the console's shell (`ConsoleLayout`).
 */

export type UndoTarget = { targetType: AuditTarget; targetId: string };

export type Receipt = {
  /** What was done, from the operator's side ("Hidden · “Black ice at the beach”"). */
  title: ReactNode;
  /** The consequence or the next step. */
  description?: ReactNode;
  /** What it was done to: where the server looks for the caller's action to undo. */
  target: UndoTarget;
};

type UndoRequest = {
  actionId: string;
  /** The undo takes something away from skaters, so it asks why. */
  needsReason: boolean;
  /** What is being undone, for the dialog's question. */
  what?: ReactNode;
};

type UndoApi = {
  announce: (receipt: Receipt) => Promise<void>;
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
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (actionId: string, why?: string): Promise<string | null> => {
      try {
        await server.run({ actionId, ...(why !== undefined ? { reason: why } : {}) });
        toast(
          { title: 'Undone', description: 'Both rows stay in the audit log', tone: 'lit' },
          manager,
        );
        return null;
      } catch (err) {
        return errorText(err);
      }
    },
    [server, manager],
  );

  const undo = useCallback(
    (request: UndoRequest) => {
      if (request.needsReason) {
        setReason('');
        setRefusal(null);
        setAsking(request);
        return;
      }
      void run(request.actionId).then((refused) => {
        if (refused !== null)
          toast({ title: 'Not undone', description: refused, tone: 'bad' }, manager);
      });
    },
    [run, manager],
  );

  const announce = useCallback(
    async ({ title, description, target }: Receipt) => {
      let latest: Awaited<ReturnType<UndoServer['latestOwn']>> = null;
      try {
        latest = await server.latestOwn(target);
      } catch {
        // The receipt still shows; only its Undo is left off (History keeps the row).
      }
      const offered = latest !== null && latest.undo.state === 'available' ? latest : null;
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
            {refusal !== null && <AlertDialogError title="Not undone.">{refusal}</AlertDialogError>}
            <AlertDialogReason value={reason} onChange={(e) => setReason(e.target.value)} />
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel />
            <AlertDialogAction
              waiting={trimmed.length === 0 || busy}
              onClick={() => {
                const request = asking;
                if (request === null) return;
                setBusy(true);
                void run(request.actionId, trimmed).then((refused) => {
                  setBusy(false);
                  if (refused === null) setAsking(null);
                  else setRefusal(refused);
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
