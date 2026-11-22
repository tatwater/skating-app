import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass } from '@fortawesome/sharp-regular-svg-icons';
import { AUDIT_REASON_MAX } from '@skating/core';
import { useContext, useEffect, useState } from 'react';

import { isFailed, type Loadable } from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { Button } from '@/components/kit/button';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Input, InputGroup, InputGroupIcon } from '@/components/kit/input';
import { ListEnd } from '@/components/kit/list-end';
import { Note } from '@/components/kit/note';
import { Skeleton } from '@/components/kit/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/components/kit/table';
import { sayRefusal } from '../../../said';
import { UnmergeLive } from '../../../shell/UnmergeLeft';
import { notSavedTitle, notSavedWhat } from '../../consoleWords';
import { ReasonAsk } from '../access/ReasonAsk';
import {
  consequenceRows,
  type MergePreview,
  mergeVerdict,
  moveRows,
  type Survivor,
} from './mergeModel';
import { MERGE_WORDS as W } from './mergeWords';

/**
 * **The merge itself, in the Shape tab's Merge block** — where this viewer may merge: a search for
 * the body that survives (beside the touching bodies the block lists), then, once one is picked, the
 * server's preview of what the merge moves, and the confirm. The confirm opens the reason dialog
 * (`ReasonAsk`, the audit log's cap: a merge's reason is its audit row's); the write is the caller's
 * (`useTabAction`, under the body hold and the save rule). Where the preview says the merge would be
 * refused — the server's sentence, or too much to move at once — that is said, and there is no
 * confirm to press.
 *
 * Props only: the search, the pick and the preview are the route's reads.
 */

/** A survivor the search found: its name, and what tells two of one name apart. */
export type SurvivorHit = Survivor & { sub: string };

export interface MergeFlowProps {
  /** The body picked to survive; `null` before one is. */
  survivor: Survivor | null;
  onPick: (survivor: Survivor | null) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** The search's hits; `null` while too little is typed to ask. */
  hits: Loadable<readonly SurvivorHit[]> | null;
  /** More bodies matched than the hits show (the search lists its first few). */
  hitsMore?: boolean;
  /** The server's preview of merging this body into the survivor; ignored with none picked. */
  preview: Loadable<MergePreview>;
  /** This body's name, for the dialog's title (the console's own record). */
  bodyName: string;
  /** This body's id: with the survivor's, where a merge refused mid-unmerge finds that unmerge. */
  bodyId?: string;
  /** Sends the merge with its reason; resolves whether it landed (the dialog closes on `true`). */
  onMerge: (reason: string) => Promise<boolean>;
}

const SUBHEAD = 'm-0 text-kick leading-none font-medium tracking-kick text-fg3 uppercase';

export function MergeFlow({
  survivor,
  onPick,
  query,
  onQueryChange,
  hits,
  hitsMore,
  preview,
  bodyName,
  bodyId,
  onMerge,
}: MergeFlowProps) {
  return (
    <div data-slot="merge-flow" className="flex w-full flex-col gap-(--space-5)">
      <MergeSearch
        survivor={survivor}
        onPick={onPick}
        query={query}
        onQueryChange={onQueryChange}
        hits={hits}
        hitsMore={hitsMore}
      />
      {survivor !== null && (
        <MergePreviewBlock
          survivor={survivor}
          preview={preview}
          bodyName={bodyName}
          {...(bodyId !== undefined ? { bodyId } : {})}
          onClear={() => onPick(null)}
          onMerge={onMerge}
        />
      )}
    </div>
  );
}

function MergeSearch({
  survivor,
  onPick,
  query,
  onQueryChange,
  hits,
  hitsMore = false,
}: Pick<MergeFlowProps, 'survivor' | 'onPick' | 'query' | 'onQueryChange' | 'hits' | 'hitsMore'>) {
  return (
    <div data-slot="merge-search" className="flex flex-col gap-(--space-2)">
      <InputGroup>
        <InputGroupIcon>
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </InputGroupIcon>
        <Input
          type="search"
          aria-label={W.searchLabel}
          placeholder={W.searchLabel}
          value={query}
          onChange={(e) => onQueryChange(e.currentTarget.value)}
        />
      </InputGroup>
      {hits === null ? null : isFailed(hits) ? (
        <ReadNote data-for="merge-search" reads={[hits]}>
          {W.searchFailed}
        </ReadNote>
      ) : hits === undefined ? (
        <Skeleton className="h-(--space-10) w-full" />
      ) : hits.length === 0 ? (
        <ListEnd>{W.searchNone}</ListEnd>
      ) : (
        <Table inset className="w-full" aria-label={W.searchLabel}>
          <TableBody>
            {hits.map((h) => {
              const picked = survivor?.id === h.id;
              return (
                <TableRow
                  key={h.id}
                  clickable
                  selected={picked}
                  data-id={h.id}
                  onClick={() => onPick(picked ? null : { id: h.id, name: h.name })}
                >
                  <TableCell lead>
                    <span className="block">{h.name}</span>
                    {h.sub !== '' && (
                      <span className="mt-(--space-1) block text-assist text-fg3">{h.sub}</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {hitsMore && hits !== null && !isFailed(hits) && hits !== undefined && hits.length > 0 && (
        <Note data-slot="merge-search-more">{W.searchMore}</Note>
      )}
    </div>
  );
}

function MergePreviewBlock({
  survivor,
  preview,
  bodyName,
  bodyId,
  onClear,
  onMerge,
}: {
  survivor: Survivor;
  bodyId?: string;
  preview: Loadable<MergePreview>;
  bodyName: string;
  onClear: () => void;
  onMerge: (reason: string) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState(false);
  const live = useContext(UnmergeLive);
  const ready = isFailed(preview) ? undefined : preview;
  const verdict = mergeVerdict(ready);
  const ok = ready?.ok ? ready : null;
  const moves = ok === null ? [] : moveRows(ok.moves);
  // **A refusal arriving while the reason dialog is open closes it for good**: a toast says why, in
  // the server's words, and the moderator opens it again themselves — it never reopens on its own
  // when the preview turns back.
  useEffect(() => {
    if (!asking || verdict.confirm) return;
    setAsking(false);
    if (verdict.said !== null) {
      sayRefusal({
        title: notSavedTitle(bodyName),
        description: notSavedWhat(W.what, verdict.said),
      });
    }
  }, [asking, verdict.confirm, verdict.said, bodyName]);
  return (
    <section
      data-slot="merge-preview"
      aria-label={W.into(survivor.name)}
      className="flex flex-col gap-(--space-3)"
    >
      <div className="flex items-baseline justify-between gap-(--space-3)">
        <h4 className={SUBHEAD}>{W.into(survivor.name)}</h4>
        <Button variant="link" size="row" onClick={onClear}>
          {W.clear}
        </Button>
      </div>
      <ReadNote data-for="merge-preview" reads={[preview]}>
        {W.previewFailed}
      </ReadNote>
      {preview === undefined && <Skeleton className="h-(--space-14) w-full" />}
      {ok !== null && (
        <KeyValueList keyWidth="6.5rem" className="gap-y-(--space-2)" data-slot="merge-moves">
          <KeyValueRow label={W.whatMoves}>
            {moves.length === 0 ? (
              <span className="text-fg3">{W.nothingMoves}</span>
            ) : (
              <span className="flex flex-wrap gap-x-(--space-3) gap-y-(--space-1)">
                {moves.map((m) => (
                  <span key={m.label} data-slot="merge-move" className="whitespace-nowrap">
                    {m.label} <span className="font-(family-name:--family-mono)">{m.value}</span>
                  </span>
                ))}
              </span>
            )}
          </KeyValueRow>
          {consequenceRows(ok).map((r) => (
            <KeyValueRow key={r.label} label={r.label}>
              {r.value}
            </KeyValueRow>
          ))}
        </KeyValueList>
      )}
      {verdict.said !== null &&
        // Refused mid-unmerge: where the route reads it live, a stalled unmerge offers Resume.
        (ready?.code === 'unmerging' && live !== null ? (
          live.note(verdict.said, [...(bodyId !== undefined ? [bodyId] : []), survivor.id])
        ) : (
          <Note data-slot="merge-refusal">{verdict.said}</Note>
        ))}
      <div>
        <Button
          size="sm"
          data-slot="merge-confirm"
          disabled={!verdict.confirm}
          onClick={() => setAsking(true)}
        >
          {W.mergeInto(survivor.name)}
        </Button>
      </div>
      <ReasonAsk
        open={asking && verdict.confirm}
        onOpenChange={setAsking}
        title={W.dialogTitle(bodyName, survivor.name)}
        description={W.dialogDescription(survivor.name)}
        confirm={W.confirm}
        label={W.reasonLabel}
        // A merge's reason is its audit row's (the audit log's cap, from core).
        maxLength={AUDIT_REASON_MAX}
        onConfirm={onMerge}
      />
    </section>
  );
}
