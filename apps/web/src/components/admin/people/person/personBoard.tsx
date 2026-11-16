/**
 * Story support: the person page in the board's detail column (8.x: the third pane, 760 × 900 at the
 * boards' 1440), with the shell's real undo toast over a fixture server — a write's receipt shows
 * with its Undo exactly as the console shows it. Story-only; nothing in the app imports it.
 */
import { useState } from 'react';

import { createToastManager, Toaster } from '@/components/kit/toast';

import { UndoProvider, type UndoServer, useUndo } from '../../shell/undo';
import type { PersonAction } from './levers';
import { PersonView, type PersonViewProps } from './PersonView';
import { NOW } from './personFixtures';
import type { PersonRead } from './personModel';
import { receiptFor } from './receipts';

export type PersonBoardProps = Omit<PersonViewProps, 'onAct' | 'onUndo' | 'now'> & {
  now?: number;
  /** Heard on every write, for a story's assertions; resolves to a refusal, or `null`. */
  onWrite?: (action: PersonAction) => Promise<string | null> | string | null | undefined;
  /** Heard on every Undo pressed (a row's, or the toast's). */
  onUndone?: (actionId: string) => void;
};

export function PersonBoard({ now = NOW, onWrite, onUndone, ...view }: PersonBoardProps) {
  const [manager] = useState(createToastManager);
  const [box, setBox] = useState<HTMLElement | null>(null);
  const server: UndoServer = {
    latestOwn: async () => ({
      actionId: 'latest',
      undo: { state: 'available', needsReason: false },
    }),
    run: async ({ actionId }) => {
      onUndone?.(actionId);
    },
  };
  return (
    <UndoProvider server={server} manager={manager}>
      <div
        ref={setBox}
        data-slot="person-board"
        className="relative h-[56.25rem] w-[47.5rem] overflow-hidden border-0 border-l border-solid border-line bg-bg"
      >
        <Wired now={now} onWrite={onWrite} onUndone={onUndone} view={view} />
        {box !== null && <Toaster manager={manager} contained container={box} />}
      </div>
    </UndoProvider>
  );
}

function Wired({
  now,
  onWrite,
  onUndone,
  view,
}: {
  now: number;
  onWrite: PersonBoardProps['onWrite'];
  onUndone: PersonBoardProps['onUndone'];
  view: Omit<PersonViewProps, 'onAct' | 'onUndo' | 'now'>;
}) {
  const { announce } = useUndo();
  const person =
    view.person !== undefined && view.person !== null && !('failed' in view.person)
      ? (view.person as PersonRead)
      : null;
  return (
    <PersonView
      {...view}
      now={now}
      onAct={async (action) => {
        const refused = (await onWrite?.(action)) ?? null;
        if (refused !== null || person === null) return refused;
        await announce({
          ...receiptFor(
            action,
            {
              displayName: person.displayName,
              defaultBountyLimit: person.rights.defaultBountyLimit,
            },
            now,
          ),
          target: { targetType: 'user', targetId: person.userId },
        });
        return null;
      }}
      onUndo={(row) => onUndone?.(row.id)}
      // The board draws Review; its sheet is the record sheet's own story.
      onReviewRecord={view.onReviewRecord ?? (() => {})}
    />
  );
}
