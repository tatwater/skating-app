import { api } from '@skating/convex/api';
import { useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { Avatar } from '@/components/kit/avatar';
import { Button } from '@/components/kit/button';
import { HistoryList, HistoryRow } from '@/components/kit/grid-list';
import { Section } from '@/components/kit/section-slug';
import { actionLabel } from './actionLabels';
import { historyWhen } from './consoleTime';
import { type UndoTarget, useUndo } from './undo';

/**
 * History (D226): the audit trail of one thing — a report, a body, a person — or of everything,
 * newest first, each row with its way back.
 *
 * - **A row is a sentence from the operator's side** ("Hid a report · “second unsafe claim”"),
 *   its time in the boards' words ("14:41", "Sat", "3 Oct"), and whoever took it on its own line
 *   under it — a person, or *System* for the machines.
 * - **Undo where the server offers it**, and nowhere else: the server marks each row with what
 *   the viewer can do (`undo` on `moderation.listActions`), so a button the server would refuse is
 *   never drawn. A row someone already undid says so and who; a row something changed since says
 *   so and jumps to the row that did, instead of offering Undo ("a later write means no undo").
 * - **Anyone holding the inverse's capability undoes anyone's action** from here, and an undo
 *   that takes something away asks why first (the reason dialog, `useUndo`).
 */

export type HistoryEntry = FunctionReturnType<typeof api.moderation.listActions>[number];

export type HistoryPanelViewProps = {
  /** Newest first. `undefined` while loading. */
  rows: readonly HistoryEntry[] | undefined;
  /** The clock the time column reads against. */
  now: number;
  /** The zone the times are written in; the reader's own when left out. */
  timeZone?: string;
  /** A row's Undo was pressed. */
  onUndo: (row: HistoryEntry) => void;
  /** The section's name. */
  title?: string;
  className?: string;
};

/** The id a row is reachable by, so "changed since" can take the reader to the row that did. */
const rowId = (id: string) => `history-${id}`;

/** Who took the action: the person's circle and name, or the machines. */
function Who({ actor }: { actor: HistoryEntry['actor'] }) {
  if (actor === null) return <span data-slot="history-system">System</span>;
  return (
    <span className="inline-flex items-center gap-(--space-1_5)">
      <Avatar name={actor.displayName} size="sm" />
      <span>{actor.displayName}</span>
    </span>
  );
}

export function HistoryPanelView({
  rows,
  now,
  timeZone,
  onUndo,
  title = 'History',
  className,
}: HistoryPanelViewProps) {
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));

  const wayBack = (row: HistoryEntry) => {
    const u = row.undo;
    switch (u.state) {
      case 'available':
        return (
          <Button size="xs" onClick={() => onUndo(row)}>
            Undo
          </Button>
        );
      case 'undone': {
        // Staff are named by first name in a row's words ("Undone · Sarah").
        const by = byId.get(u.byActionId)?.actor?.displayName.split(' ')[0];
        return (
          <span data-slot="history-undone" className="text-assist leading-list text-fg3">
            Undone{by !== undefined ? ` · ${by}` : ''}
          </span>
        );
      }
      case 'overtaken': {
        const later = byId.get(u.byActionId);
        if (later === undefined) {
          return (
            <span data-slot="history-overtaken" className="text-assist leading-list text-fg3">
              Changed since
            </span>
          );
        }
        return (
          <Button
            variant="link"
            size="xs"
            data-slot="history-overtaken"
            aria-label={`Changed since: ${actionLabel(later.action, later.targetType)}, ${historyWhen(later.createdAt, now, timeZone)}`}
            onClick={() => {
              const el = document.getElementById(rowId(later.id));
              el?.scrollIntoView({ block: 'nearest' });
              el?.focus();
            }}
          >
            Changed since
          </Button>
        );
      }
      default:
        return undefined;
    }
  };

  return (
    <Section
      title={title}
      {...(rows !== undefined ? { count: rows.length } : {})}
      aria-busy={rows === undefined ? true : undefined}
      className={className}
    >
      {rows !== undefined && rows.length > 0 && (
        <HistoryList>
          {rows.map((row) => {
            const reason = row.reason.trim();
            return (
              <HistoryRow
                key={row.id}
                id={rowId(row.id)}
                tabIndex={-1}
                data-state={row.undo.state}
                className="outline-none focus-visible:shadow-focus"
                when={historyWhen(row.createdAt, now, timeZone)}
                who={<Who actor={row.actor} />}
                action={wayBack(row)}
              >
                {actionLabel(row.action, row.targetType)}
                {row.undoesActionId !== undefined && ' · an undo'}
                {reason.length > 0 && <span className="text-fg3"> · “{reason}”</span>}
              </HistoryRow>
            );
          })}
        </HistoryList>
      )}
    </Section>
  );
}

/**
 * History wired to the server: one target's trail (a body's, a person's, a report's), or every
 * action when no target is given. Bounded by the server (`moderation.listActions` caps its read).
 */
export function HistoryPanel({
  target,
  limit,
  title,
  className,
}: {
  target?: UndoTarget;
  limit?: number;
  title?: string;
  className?: string;
}) {
  const rows = useQuery(api.moderation.listActions, {
    ...(target !== undefined ? target : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  const { undo } = useUndo();
  return (
    <HistoryPanelView
      rows={rows}
      now={Date.now()}
      onUndo={(row) =>
        undo({
          actionId: row.id,
          needsReason: row.undo.state === 'available' && row.undo.needsReason,
          what: actionLabel(row.action, row.targetType),
        })
      }
      {...(title !== undefined ? { title } : {})}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
