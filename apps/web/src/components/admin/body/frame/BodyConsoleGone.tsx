import { type ReactElement, type ReactNode, useRef } from 'react';
import { isFailed, type Loadable } from '@/components/admin/reads/consoleReads';
import { ReadNote } from '@/components/admin/reads/ReadNote';
import { Avatar } from '@/components/kit/avatar';
import { Button } from '@/components/kit/button';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Note } from '@/components/kit/note';
import { SkeletonText } from '@/components/kit/skeleton';
import { usePaneKeys } from '@/lib/keys';
import { ConsoleTopStart } from '../../shell/ConsoleShell';
import { LEFT_NOT_SAID } from '../consoleWords';
import { NOT_RECORDED } from '../tabs/tabStates';
import { BodyHistorySection } from './BodyLeftColumn';
import type { Removal } from './bodyModel';
import { IN_NO_TOWN_WORDS, NOT_COMPUTED, NOT_COMPUTED_WORDS } from './bodyModel';
import type { BodyGoneData } from './useBodyConsole';

/**
 * **A body the console can't open** — rejected by a moderator, or merged into another body. The
 * page says so plainly, then what the record still holds: how it left (when, by whom, why), and for
 * a rejected body the towns it lies in and its reports; then its history. Never an empty console,
 * never *No body open*.
 *
 * A merged body points at the body that took it in. A rejected body's name and outline aren't
 * served for it (the body's read answers only that it is unavailable), and the page says that too
 * rather than leaving the gap unexplained.
 */

export type BodyConsoleGoneProps = BodyGoneData & {
  /** The survivor's console, as a router link (`<Link to="/admin/body/$id" … />`). */
  survivorLink?: (id: string) => ReactElement;
  /** ⇧⏎ and the top bar's place control: back to the list. */
  onReturn?: () => void;
  now: number;
  timeZone?: string;
};

const int = new Intl.NumberFormat('en-US');

export function BodyConsoleGone({
  survivor,
  removal,
  removalShown,
  towns,
  reports,
  history,
  record,
  survivorLink,
  onReturn,
  now,
  timeZone,
}: BodyConsoleGoneProps) {
  const root = useRef<HTMLDivElement | null>(null);
  usePaneKeys(root, [
    {
      key: 'Shift+Enter',
      label: 'Back to the list',
      enabled: onReturn !== undefined,
      run: () => onReturn?.(),
    },
  ]);
  return (
    <div
      ref={root}
      data-slot="body-console-gone"
      className="flex h-full min-h-0 flex-col overflow-y-auto p-gutter"
    >
      <div className="flex w-full max-w-(--size-inspector) flex-col items-start gap-(--space-3_5)">
        <Note data-slot="body-gone-note">
          {survivor !== null ? (
            <>
              This body was merged into <strong>{survivor.name}</strong>. Its reports, hazards,
              bays, landmarks and favorites moved there.
            </>
          ) : (
            <>
              This body has been removed. The map and the console no longer open it; what its record
              still holds is below.
            </>
          )}
        </Note>
        {survivor !== null && survivorLink !== undefined && (
          <Button variant="link" size="sm" render={survivorLink(survivor.id)}>
            Open {survivor.name}
          </Button>
        )}
        <KeyValueList keyWidth="5.5rem" className="mt-(--space-2) w-full gap-y-(--space-2_5)">
          {record !== null && <RecordRows record={record} />}
          {removalShown && <RemovalRow removal={removal} merged={survivor !== null} />}
          {towns !== null && <TownsRow towns={towns} />}
          {reports !== null && <ReportsRow reports={reports} />}
        </KeyValueList>
        <ReadNote data-for="body-gone-facts" reads={[towns, reports, record]}>
          What the record holds about it couldn’t be read
        </ReadNote>
      </div>
      {history !== null && (
        <div className="w-full max-w-(--size-inspector)">
          <BodyHistorySection
            history={history}
            now={now}
            {...(timeZone !== undefined ? { timeZone } : {})}
          />
        </div>
      )}
      {onReturn !== undefined && (
        <ConsoleTopStart>
          <Button variant="outline" size="sm" onClick={onReturn} aria-keyshortcuts="Shift+Enter">
            Bodies
          </Button>
        </ConsoleTopStart>
      )}
    </div>
  );
}

/** How it left. A failed read says so once, in History; here its row simply waits. */
function RemovalRow({ removal, merged }: { removal: Loadable<Removal | null>; merged: boolean }) {
  if (isFailed(removal)) return null;
  if (removal === undefined) {
    return (
      <KeyValueRow label={merged ? 'Merged' : 'Removed'}>
        <SkeletonText width="9rem" lines={2} className="text-row leading-list" />
      </KeyValueRow>
    );
  }
  if (removal === null) {
    return (
      <KeyValueRow label={merged ? 'Merged' : 'Removed'}>
        <Faint>{merged ? 'The history read doesn’t say when or by whom' : LEFT_NOT_SAID}</Faint>
      </KeyValueRow>
    );
  }
  return (
    <KeyValueRow label={removal.verb}>
      <span className="flex flex-col gap-(--space-1_5)" data-slot="body-gone-removal">
        <span>{removal.when}</span>
        {removal.who !== null && (
          <span className="inline-flex items-center gap-(--space-2)">
            <Avatar name={removal.who} size="sm" />
            {removal.who}
          </span>
        )}
        {removal.because !== undefined && <span>{removal.because}</span>}
        {removal.reason !== null && <Faint>“{removal.reason}”</Faint>}
      </span>
    </KeyValueRow>
  );
}

function TownsRow({ towns }: { towns: Loadable<readonly string[] | typeof NOT_COMPUTED | null> }) {
  if (isFailed(towns) || towns === null) return null;
  if (towns === undefined) {
    return (
      <KeyValueRow label="Towns">
        <SkeletonText width="8rem" className="text-row leading-list" />
      </KeyValueRow>
    );
  }
  if (towns === NOT_COMPUTED || towns.length === 0) {
    return (
      <KeyValueRow label="Towns">
        <span className="text-fg3">
          {towns === NOT_COMPUTED ? NOT_COMPUTED_WORDS : IN_NO_TOWN_WORDS}
        </span>
      </KeyValueRow>
    );
  }
  return (
    <KeyValueRow label="Towns">
      <span className="flex flex-col gap-(--space-1_5)">
        {towns.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </span>
    </KeyValueRow>
  );
}

function ReportsRow({ reports }: { reports: Loadable<{ count: number; capped: boolean } | null> }) {
  if (isFailed(reports) || reports === null) return null;
  return (
    <KeyValueRow label="Reports">
      {reports === undefined ? (
        <SkeletonText width="7rem" className="text-row leading-list" />
      ) : (
        <span data-slot="body-gone-reports">
          {/* A capped count is a floor, never a total. */}
          {int.format(reports.count)}
          {reports.capped ? '+' : ''} since the record began
        </span>
      )}
    </KeyValueRow>
  );
}

/** The stored record of a body that left: its name, class, states and area. */
function RecordRows({ record }: { record: Exclude<BodyConsoleGoneProps['record'], null> }) {
  if (isFailed(record) || record === null) return null;
  if (record === undefined) {
    return (
      <KeyValueRow label="Name">
        <SkeletonText width="9rem" className="text-row leading-list" />
      </KeyValueRow>
    );
  }
  return (
    <>
      <KeyValueRow label="Name">
        <span data-slot="body-gone-name">{record.name}</span>
      </KeyValueRow>
      <KeyValueRow label="Class">{record.kind}</KeyValueRow>
      {record.states.length > 0 && (
        <KeyValueRow label="States">{record.states.join(', ')}</KeyValueRow>
      )}
      <KeyValueRow label="Area">
        {record.area === null ? <Faint>{NOT_RECORDED}</Faint> : record.area}
      </KeyValueRow>
    </>
  );
}

function Faint({ children }: { children: ReactNode }) {
  return <span className="text-fg3">{children}</span>;
}
