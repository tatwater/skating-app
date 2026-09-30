import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  CORPUS_NAME_DISMISS_LABELS,
  type CorpusNameDismissReason,
  type CorpusNameStatus,
} from '@skating/core';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { BodyPicker } from '../sheet/BodyPicker';
import { Button, buttonVariants } from '../ui/button';
import { AdminEmpty, AdminPageHeader, errorText, Table, Td, Th } from './adminUi';
import { DismissPlaceNameDialog } from './DismissPlaceNameDialog';

const TABS: readonly { status: CorpusNameStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'placed', label: 'Placed' },
  { status: 'dismissed', label: 'Dismissed' },
];

type Row = FunctionReturnType<typeof api.corpusPlaceNames.listQueue>['rows'][number];

/**
 * Place names (D202) — **the places the community's emails name that no landmark took**, most
 * mentioned first: "Apple Island" (a peninsula since the causeway, in neither catalog), "Hero's
 * Welcome", "the sea caves". Loaded from the landmark pass's leftovers (`load-landmark-names`).
 *
 * This page triages; the lake editor places. A name here needs a lake — the emails said which for
 * about half of them, and for the rest a moderator picks one (or among the lakes a name met). Once a
 * name has a lake, *Place it* opens that lake's editor, whose Landmarks card lists it: drop the point
 * for it, or file it as another spelling of a landmark already there. A name that is not a place — a
 * phrase, a lake, somewhere outside the five states — is dismissed with a reason, and can be reopened.
 */
export function PlaceNameQueue() {
  const [status, setStatus] = useState<CorpusNameStatus>('open');
  // One email's passing mention is most of the list; the names skaters use again are the work.
  const [recurringOnly, setRecurringOnly] = useState(true);
  const result = useQuery(api.corpusPlaceNames.listQueue, {
    status,
    ...(recurringOnly ? { minMessages: 2 } : {}),
  });
  const setLake = useMutation(api.corpusPlaceNames.setLake);
  const reopen = useMutation(api.corpusPlaceNames.reopen);
  const [picking, setPicking] = useState<Row | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const act = async (write: () => Promise<unknown>, ok: string) => {
    try {
      await write();
      setMessage({ tone: 'ok', text: ok });
    } catch (err) {
      setMessage({ tone: 'error', text: errorText(err) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader
        title="Place names"
        subtitle="Places the community's emails name that no landmark took. Give each a lake, then place it from that lake's editor — or dismiss it."
      />

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((tab) => (
          <Button
            key={tab.status}
            size="sm"
            variant={status === tab.status ? 'default' : 'outline'}
            onClick={() => setStatus(tab.status)}
          >
            {tab.label}
          </Button>
        ))}
        <label className="ml-2 flex items-center gap-1.5 text-foreground-muted text-sm">
          <input
            type="checkbox"
            checked={recurringOnly}
            onChange={(e) => setRecurringOnly(e.target.checked)}
            className="size-3.5"
          />
          Only names mentioned more than once
        </label>
      </div>

      {message ? (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`rounded-md border px-3 py-2 text-sm ${
            message.tone === 'ok'
              ? 'border-border bg-surface-muted text-foreground'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          {message.text}
        </p>
      ) : null}

      {result === undefined ? (
        <AdminEmpty>Loading…</AdminEmpty>
      ) : result.rows.length === 0 ? (
        <AdminEmpty>
          {status === 'open'
            ? recurringOnly
              ? 'No name mentioned more than once is waiting. Untick the filter for the names one email used.'
              : 'Nothing waiting — every name is placed or dismissed.'
            : `No ${status} names${recurringOnly ? ' mentioned more than once' : ''}.`}
        </AdminEmpty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th className="text-right">Mentions</Th>
              <Th>Lake</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row._id}>
                <Td>
                  <p className="font-medium">{row.name}</p>
                  {row.aliases.length > 0 ? (
                    <p className="text-foreground-muted text-xs">also {row.aliases.join(', ')}</p>
                  ) : null}
                  {row.alreadyNamed ? (
                    <p className="text-foreground-muted text-xs">
                      Already a landmark — the emails did not say which one. Choose it in the lake
                      editor.
                    </p>
                  ) : null}
                  {row.status === 'dismissed' && row.dismissReason ? (
                    <p className="text-foreground-muted text-xs">
                      {CORPUS_NAME_DISMISS_LABELS[row.dismissReason as CorpusNameDismissReason]}
                      {row.dismissNote ? ` — ${row.dismissNote}` : ''}
                    </p>
                  ) : null}
                </Td>
                <Td className="text-right font-mono text-xs">
                  {row.messages}
                  {row.skatedMessages > 0 ? (
                    <span className="block text-foreground-muted">{row.skatedMessages} skated</span>
                  ) : null}
                </Td>
                <Td>
                  <LakeCell
                    row={row}
                    editable={row.status === 'open'}
                    onPick={() => setPicking(row)}
                    onChoose={(waterBodyId, label) =>
                      void act(
                        () => setLake({ id: row._id, waterBodyId }),
                        `“${row.name}” is on ${label}.`,
                      )
                    }
                  />
                </Td>
                <Td className="whitespace-nowrap text-right">
                  {row.status === 'open' ? (
                    <span className="flex justify-end gap-1">
                      {row.lake ? (
                        <Link
                          to="/admin/water/$id"
                          params={{ id: row.lake._id }}
                          className={buttonVariants({ size: 'xs' })}
                        >
                          {row.alreadyNamed ? 'Choose which' : 'Place it'}
                        </Link>
                      ) : null}
                      <DismissPlaceNameDialog
                        id={row._id}
                        name={row.name}
                        onDone={() => setMessage({ tone: 'ok', text: `Dismissed “${row.name}”.` })}
                        trigger={
                          <Button size="xs" variant="ghost">
                            Dismiss
                          </Button>
                        }
                      />
                    </span>
                  ) : row.status === 'dismissed' ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void act(() => reopen({ id: row._id }), `Reopened “${row.name}”.`)
                      }
                    >
                      Reopen
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {result?.capped ? (
        <p className="text-foreground-muted text-xs">
          Showing the most mentioned first; more wait behind these.
        </p>
      ) : null}

      <BodyPicker
        open={picking !== null}
        title={picking ? `Which lake is “${picking.name}” on?` : 'Which lake?'}
        onClose={() => setPicking(null)}
        onPick={({ waterBodyId, name }) => {
          const row = picking;
          setPicking(null);
          if (row) {
            void act(
              () => setLake({ id: row._id, waterBodyId: waterBodyId as Id<'waterBodies'> }),
              `“${row.name}” is on ${name}.`,
            );
          }
        }}
      />
    </div>
  );
}

/** Where a name is: its lake (a link), the lakes it might be on (a choice), or a lake to pick. */
function LakeCell({
  row,
  editable,
  onPick,
  onChoose,
}: {
  row: Row;
  editable: boolean;
  onPick: () => void;
  onChoose: (waterBodyId: Id<'waterBodies'>, label: string) => void;
}) {
  const said = row.parentName ? (
    <p className="text-foreground-muted text-xs">
      The emails said {row.parentName}
      {row.states.length > 0 ? ` (${row.states.join(', ')})` : ''}
    </p>
  ) : row.states.length > 0 ? (
    <p className="text-foreground-muted text-xs">Seen in {row.states.join(', ')}</p>
  ) : null;

  if (row.lake) {
    return (
      <div className="flex flex-col gap-0.5">
        <Link
          to="/admin/water/$id"
          params={{ id: row.lake._id }}
          className="underline underline-offset-2"
        >
          {row.lake.label}
        </Link>
        {editable ? (
          <button
            type="button"
            className="self-start text-foreground-muted text-xs underline underline-offset-2"
            onClick={onPick}
          >
            Another lake
          </button>
        ) : null}
      </div>
    );
  }
  if (!editable) return said;
  return (
    <div className="flex flex-col gap-1">
      {said}
      <div className="flex flex-wrap gap-1">
        {row.candidates.map((lake) => (
          <Button
            key={lake._id}
            size="xs"
            variant="outline"
            onClick={() => onChoose(lake._id, lake.label)}
          >
            {lake.label}
          </Button>
        ))}
        <Button
          size="xs"
          variant={row.candidates.length > 0 ? 'ghost' : 'outline'}
          onClick={onPick}
        >
          {row.candidates.length > 0 ? 'Another lake…' : 'Pick a lake…'}
        </Button>
      </div>
    </div>
  );
}
