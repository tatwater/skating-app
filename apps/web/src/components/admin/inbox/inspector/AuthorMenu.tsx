import { api } from '@skating/convex/api';
import { AUDIT_REASON_MAX } from '@skating/core';
import { useQuery } from 'convex/react';
import { Fragment, useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuNote,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { PersonLockup } from '@/components/kit/person-lockup';
import { ToolbarItem } from '@/components/kit/toolbar';

import { AskDialog } from '../../people/person/AskDialog';
import {
  accountRows,
  canDoRows,
  type LeverButton,
  type LeverRow,
  type PersonAction,
  type ReasonAsk,
} from '../../people/person/levers';
import type { PersonRead } from '../../people/person/personModel';
import { SuspendDialog } from '../../people/person/SuspendDialog';
import { useActing } from '../../people/person/useActing';
import { usePersonWrites } from '../../people/person/usePersonWrites';
import { useClockFor } from '../../reads/readArgs';
import { useHeldRead } from '../../shell/presence';
import { FLAG_WORDS as W } from '../handlers/Flag/flagWords';

/**
 * **The author menu** (board 2.1's *Author* control in the bar): the person's circle and real name;
 * opened, the person levers People draws for them — posting rights, flagging, a suspension, a ban —
 * each **exactly as People's** (`levers.ts` from the People read's `can`, `usePersonWrites`, the same
 * dialogs), so a lever here is drawn only when People's would be and writes what People's writes.
 * Then *Open in People →*. Role, ledger and bounty levers stay on the People page. A moderator never
 * sees a lever their role can't use: the server's `can` leaves it out, so nothing is labeled as
 * admin-only.
 */

/** A lever drawn in the menu: the row it belongs to, and a button that can run. */
export type MenuLever = {
  row: Pick<LeverRow, 'key' | 'label' | 'status'>;
  buttons: Extract<LeverButton, { opens: unknown }>[];
};

const MENU_ROWS = new Set(['reports', 'hazards', 'comments', 'flagging', 'suspension', 'ban']);

/** The menu's levers from a People read: the discipline rows, the buttons `can` allows. */
export function menuLevers(p: PersonRead, now: number): MenuLever[] {
  const rows = [...canDoRows(p, { now }), ...accountRows(p, { now, self: false })];
  return rows
    .filter((r) => MENU_ROWS.has(r.key))
    .map((r) => ({
      row: { key: r.key, label: r.label, status: r.status },
      buttons: r.buttons.filter(
        (b): b is Extract<LeverButton, { opens: unknown }> =>
          'opens' in b &&
          (b.opens.kind === 'now' || b.opens.kind === 'reason' || b.opens.kind === 'suspend'),
      ),
    }))
    .filter((l) => l.buttons.length > 0);
}

export type AuthorMenuViewProps = {
  name: string;
  /** The levers; `'loading'` while the People read is on its way. */
  levers: readonly MenuLever[] | 'loading';
  onPick: (button: MenuLever['buttons'][number]) => void;
  /** The person's People page. */
  peopleHref: string;
  busy?: boolean;
};

/** The menu, drawn from props. */
export function AuthorMenuView({
  name,
  levers,
  onPick,
  peopleHref,
  busy = false,
}: AuthorMenuViewProps) {
  return (
    <DropdownMenu>
      <ToolbarItem
        aria-label={W.authorMenu(name)}
        data-slot="author-menu"
        render={
          <DropdownMenuTrigger render={<Button loading={busy} />}>
            <PersonLockup name={name} />
            <DropdownMenuCaret />
          </DropdownMenuTrigger>
        }
      />
      <DropdownMenuContent align="end" data-slot="author-menu-content">
        {levers === 'loading' ? (
          <DropdownMenuNote>{W.leversLoading}</DropdownMenuNote>
        ) : levers.length === 0 ? (
          <DropdownMenuNote>{W.noLevers}</DropdownMenuNote>
        ) : (
          levers.map((l, i) => (
            <Fragment key={l.row.key}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {l.row.label} · {l.row.status}
                </DropdownMenuLabel>
                {l.buttons.map((b) => (
                  <DropdownMenuItem
                    key={b.id}
                    data-lever={b.id}
                    label={`${l.row.label} ${b.label}`}
                    variant={b.danger === true ? 'danger' : 'default'}
                    onClick={() => onPick(b)}
                  >
                    {b.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </Fragment>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-slot="author-menu-people"
          label={W.openInPeople}
          render={<a href={peopleHref} />}
        >
          {W.openInPeople} →
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Open =
  | { id: string; kind: 'reason'; ask: ReasonAsk; serial: number }
  | {
      id: string;
      kind: 'suspend';
      extend: boolean;
      serial: number;
      /** What the dialog shows, taken when it opened: a re-read never unmounts it. */
      until: number | null;
      replacesBan: boolean;
    };

/**
 * The menu bound to People's read and writes for `userId` — reads `people.person` (its `can` is the
 * law), writes through `usePersonWrites`, dialogs as the People page's.
 */
export function AuthorMenu({
  userId,
  name,
  now,
  peopleHref = `/admin/people/${userId}`,
}: {
  userId: string;
  name: string;
  now: number;
  peopleHref?: string;
}) {
  // The People read on the minute this person was opened, held while they stay open (People's own
  // pane holds it the same way): keyed on the page's live minute, each tick would be a new
  // subscription answering `undefined` until it lands — the levers would blink and an open dialog
  // would lose what was typed. A re-read for another reason still keeps the last answer.
  const held = useClockFor(userId);
  const person = useHeldRead(
    useQuery(api.people.person, { userId, now: held }) as PersonRead | null | undefined,
    false,
  );
  const write = usePersonWrites(
    person == null
      ? null
      : { userId, displayName: name, defaultBountyLimit: person.rights.defaultBountyLimit },
    now,
  );
  const acting = useActing(write);
  const region = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Open | null>(null);
  const levers = person === undefined ? 'loading' : person === null ? [] : menuLevers(person, now);
  const run = (id: string, action: PersonAction, inline: boolean) =>
    acting.act(id, action, { region: region.current, inline });
  const pick = (b: MenuLever['buttons'][number]) => {
    const serial = (shown?.serial ?? 0) + 1;
    switch (b.opens.kind) {
      case 'now':
        void run(b.id, b.opens.action, true);
        return;
      case 'reason':
        setShown({ id: b.id, kind: 'reason', ask: b.opens.ask, serial });
        setOpen(true);
        return;
      case 'suspend':
        if (person == null) return;
        setShown({
          id: b.id,
          kind: 'suspend',
          extend: b.opens.extend,
          serial,
          until: person.statusNote?.suspendedUntil ?? null,
          replacesBan: person.status === 'banned',
        });
        setOpen(true);
        return;
      default:
        return;
    }
  };
  return (
    <>
      <AuthorMenuView
        name={name}
        levers={levers}
        onPick={pick}
        peopleHref={peopleHref}
        busy={acting.busy !== null}
      />
      {shown?.kind === 'reason' && (
        <AskDialog
          key={shown.serial}
          open={open}
          onOpenChange={setOpen}
          title={shown.ask.title}
          description={shown.ask.description}
          confirm={shown.ask.confirm}
          reason
          // The server's cap on an audit reason: an over-long one is stopped here, not refused.
          maxLength={AUDIT_REASON_MAX}
          destructive={shown.ask.destructive === true}
          onConfirm={(reason) => run(shown.id, shown.ask.action(reason), false)}
        />
      )}
      {shown?.kind === 'suspend' && (
        <SuspendDialog
          key={shown.serial}
          open={open}
          onOpenChange={setOpen}
          name={name}
          extend={shown.extend}
          until={shown.until}
          replacesBan={shown.replacesBan}
          now={now}
          onConfirm={({ until, reason, shape }) =>
            run(
              shown.id,
              {
                kind: 'suspend',
                until,
                reason,
                extend: shown.extend,
                ...(shape !== 'suspend' && { shape }),
              },
              false,
            )
          }
        />
      )}
    </>
  );
}
