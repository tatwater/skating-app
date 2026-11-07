import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { UserStatus } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { type ReactNode, useState } from 'react';

import { useRole } from '@/lib/useRole';

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
  AlertDialogTrigger,
} from '../../kit/alert-dialog';
import { Button, buttonVariants } from '../../kit/button';
import { Field, FieldLabel, Input } from '../../kit/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../kit/select';
import { shortDay } from './profileModel';

/** The subset of `profiles.getAdmin` the levers read. */
export interface ModeratedUser {
  userId: string;
  username: string;
  status: UserStatus;
  suspendedUntil?: number;
  canPostReports: boolean;
  canPostHazards: boolean;
  canPostComments: boolean;
  /** Absent ⇒ the global cap; `0` ⇒ no bounties. */
  activeBountyPostLimit?: number;
}

export type Permission = 'reports' | 'hazards' | 'comments';

export interface ModeratorLevers {
  setPermission: (permission: Permission, allowed: boolean, reason: string) => Promise<unknown>;
  setBountyLimit: (limit: number | undefined, reason: string) => Promise<unknown>;
  suspend: (days: number, reason: string) => Promise<unknown>;
  ban: (reason: string) => Promise<unknown>;
  reinstate: (reason: string) => Promise<unknown>;
}

const SUSPEND_DAYS = [1, 3, 7, 30];

/** "Global cap", "Limit 2", "No bounties". */
export function bountyLimitLabel(limit: number | undefined): string {
  if (limit === undefined) return 'Global cap';
  return limit === 0 ? 'No bounties' : `Limit ${limit}`;
}

/** "Active", "Suspended · until Jan 19", "Banned". */
export function statusLabel(user: Pick<ModeratedUser, 'status' | 'suspendedUntil'>): {
  value: string;
  sub?: string;
} {
  if (user.status === 'suspended') {
    return user.suspendedUntil
      ? { value: 'Suspended', sub: `Until ${shortDay(user.suspendedUntil)}` }
      : { value: 'Suspended' };
  }
  if (user.status === 'banned') return { value: 'Banned' };
  return { value: 'Active' };
}

/**
 * The moderator's tools on someone's page (6.8, D37): the same levers as the console, over the same
 * server-gated mutations, so the two can't drift. Every lever goes through the reason dialog —
 * the server keeps the reason in the audit log — and the ones that take something away arm before
 * they act. The full record is the console's, in a new tab.
 */
export function ModeratorToolsView({
  user,
  levers,
}: {
  user: ModeratedUser;
  levers: ModeratorLevers;
}) {
  const status = statusLabel(user);
  const perms: [Permission, string, boolean][] = [
    ['reports', 'Reports', user.canPostReports],
    ['hazards', 'Hazards', user.canPostHazards],
    ['comments', 'Comments', user.canPostComments],
  ];
  return (
    <section
      aria-label="Moderator tools"
      className="flex flex-col border border-line2 border-solid [&>[data-row]:last-child]:border-b-0"
    >
      <div className="flex items-center gap-(--space-2_5) border-0 border-line border-b border-solid px-(--space-4) py-(--space-3)">
        <span className="whitespace-nowrap font-medium text-fg2 text-kick uppercase leading-none tracking-kick">
          Moderator tools
        </span>
        <a
          href={`/admin/users/${user.userId}`}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'link', size: 'sm', className: 'ml-auto' })}
        >
          Console
          <FontAwesomeIcon
            icon={faArrowUpRightFromSquare}
            aria-hidden="true"
            className="h-[0.9em]"
          />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </div>
      <Group>Posting</Group>
      {perms.map(([permission, label, allowed]) => (
        <Lever key={permission} label={label} value={allowed ? 'Allowed' : 'Restricted'}>
          {allowed ? (
            <ReasonDialog
              trigger="Restrict"
              title={`Restrict ${permission} from @${user.username}?`}
              description="A lever finer than a ban — their other contributions stand."
              action="Restrict"
              destructive
              onConfirm={(reason) => levers.setPermission(permission, false, reason)}
            />
          ) : (
            <ReasonDialog
              trigger="Restore"
              title={`Restore ${permission} for @${user.username}?`}
              action="Restore"
              onConfirm={(reason) => levers.setPermission(permission, true, reason)}
            />
          )}
        </Lever>
      ))}
      <Lever label="Open bounties" value={bountyLimitLabel(user.activeBountyPostLimit)}>
        <BountyLimitDialog user={user} levers={levers} />
      </Lever>
      <Group>Account</Group>
      <Lever label="Status" value={status.value} sub={status.sub}>
        {user.status === 'active' ? (
          <>
            <SuspendDialog user={user} levers={levers} />
            <ReasonDialog
              trigger="Ban"
              triggerDanger
              title={`Ban @${user.username}?`}
              description="Indefinite. The account is kept for an appeal, and their sign-in is locked."
              action="Ban"
              destructive
              onConfirm={levers.ban}
            />
          </>
        ) : (
          <ReasonDialog
            trigger="Reinstate"
            title={`Reinstate @${user.username}?`}
            action="Reinstate"
            onConfirm={levers.reinstate}
          />
        )}
      </Lever>
    </section>
  );
}

function Group({ children }: { children: string }) {
  return (
    <div className="px-(--space-4) pt-(--space-3_5) pb-(--space-1)">
      <span className="font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
        {children}
      </span>
    </div>
  );
}

function Lever({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      data-row=""
      className="flex items-center gap-(--space-3) border-0 border-line border-b border-solid px-(--space-4) py-(--space-2_5) text-fg1 text-row"
    >
      <span className="w-[6.25rem] flex-none text-assist text-fg2">{label}</span>
      <span className="flex-1">
        {value}
        {sub && <small className="mt-[0.125rem] block text-assist text-fg3">{sub}</small>}
      </span>
      <span className="ml-auto flex gap-(--space-2)">{children}</span>
    </div>
  );
}

/** The reason dialog around one lever: a reason, then the action (armed first when it takes away). */
function ReasonDialog({
  trigger,
  triggerDanger = false,
  title,
  description,
  action,
  destructive = false,
  fields,
  onConfirm,
}: {
  trigger: string;
  triggerDanger?: boolean;
  title: string;
  description?: string;
  action: string;
  destructive?: boolean;
  fields?: ReactNode;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setReason('');
          setRefused(null);
        }
      }}
    >
      <AlertDialogTrigger
        render={
          <Button size="sm" variant={triggerDanger ? 'danger' : 'outline'} armed={triggerDanger} />
        }
      >
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogBody>
          {refused && <AlertDialogError>{refused}</AlertDialogError>}
          {fields}
          <AlertDialogReason
            label="Reason · audit log"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <AlertDialogAction
            destructive={destructive}
            waiting={reason.trim().length === 0}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setRefused(null);
              try {
                await onConfirm(reason.trim());
                setOpen(false);
                setReason('');
              } catch (e) {
                setRefused(e instanceof Error ? e.message : 'The server refused it.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SuspendDialog({ user, levers }: { user: ModeratedUser; levers: ModeratorLevers }) {
  const [days, setDays] = useState(3);
  return (
    <ReasonDialog
      trigger="Suspend"
      triggerDanger
      title={`Suspend @${user.username}?`}
      description="A temporary hold; the account reactivates by itself when it lapses."
      action="Suspend"
      destructive
      fields={
        <Field>
          <FieldLabel>Duration</FieldLabel>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger aria-label="Duration">
              <SelectValue>{`${days} day${days === 1 ? '' : 's'}`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SUSPEND_DAYS.map((d) => (
                <SelectItem key={d} value={String(d)}>{`${d} day${d === 1 ? '' : 's'}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      }
      onConfirm={(reason) => levers.suspend(days, reason)}
    />
  );
}

function BountyLimitDialog({ user, levers }: { user: ModeratedUser; levers: ModeratorLevers }) {
  const [value, setValue] = useState(
    user.activeBountyPostLimit === undefined ? '' : String(user.activeBountyPostLimit),
  );
  const limit = value.trim() === '' ? undefined : Math.max(0, Math.floor(Number(value)));
  return (
    <ReasonDialog
      trigger="Set limit"
      title={`Open-bounty limit for @${user.username}`}
      description="Blank restores the global cap. Zero stops bounties while leaving reports and hazards alone."
      action={limit === undefined ? 'Use the global cap' : 'Set limit'}
      fields={
        <Field>
          <FieldLabel>Limit</FieldLabel>
          <Input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="Global cap"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
      }
      onConfirm={(reason) => levers.setBountyLimit(limit, reason)}
    />
  );
}

const DAY_MS = 86_400_000;

/**
 * The moderator panel, wired: nothing for a non-moderator, nothing on your own page, and nothing
 * while you're leaving (a departing moderator keeps reads, not writes — `canModerate`).
 */
export function ProfileModeratorTools({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { canModerate } = useRole();
  const user = useQuery(
    api.profiles.getAdmin,
    canModerate && !isSelf ? { userId: userId as Id<'profiles'> } : 'skip',
  );
  const setPerm = useMutation(api.moderation.setPostingPermission);
  const setLimit = useMutation(api.moderation.setBountyPostLimit);
  const suspend = useMutation(api.moderation.suspendUser);
  const ban = useMutation(api.moderation.banUser);
  const unban = useMutation(api.moderation.unbanUser);
  if (!canModerate || isSelf || !user) return null;
  const id = userId as Id<'profiles'>;
  return (
    <ModeratorToolsView
      user={user as ModeratedUser}
      levers={{
        setPermission: (permission, allowed, reason) =>
          setPerm({ userId: id, permission, allowed, reason }),
        setBountyLimit: (limit, reason) =>
          setLimit({ userId: id, ...(limit === undefined ? {} : { limit }), reason }),
        suspend: (days, reason) =>
          suspend({ userId: id, reason, suspendedUntil: Date.now() + days * DAY_MS }),
        ban: (reason) => ban({ userId: id, reason }),
        reinstate: (reason) => unban({ userId: id, reason }),
      }}
    />
  );
}
