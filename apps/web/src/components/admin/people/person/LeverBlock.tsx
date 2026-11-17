import { useRef, useState } from 'react';

import { Button } from '@/components/kit/button';
import { ButtonGroup } from '@/components/kit/button-group';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { Section } from '@/components/kit/section-slug';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';

import { AskDialog } from './AskDialog';
import { BountyDialog } from './BountyDialog';
import { useSectionLevel } from './headingLevel';
import { LeverList, LeverRow } from './kit-candidates/lever-row';
import type {
  LeverButton,
  LeverRow as LeverRowModel,
  PersonAction,
  ReasonAsk,
  RoleItem,
} from './levers';
import { type PersonRead, ROLE_ARTICLE, ROLE_WORDS, shownName } from './personModel';
import { WORDS } from './personWords';
import { SuspendDialog } from './SuspendDialog';
import type { useActing } from './useActing';

/**
 * A titled block of lever rows — *Can do* or *Account* — with the dialogs its buttons open. What
 * each row draws and allows is decided in `levers.ts` from `can`; this only draws it and runs the
 * writes through `useActing` (busy in place, a refusal in its toast, focus kept in the block).
 *
 * None of these buttons has a key of its own: role changes and discipline are pressed, never typed.
 */

type Acting = ReturnType<typeof useActing>;

export type LeverBlockProps = {
  title: string;
  rows: readonly LeverRowModel[];
  person: PersonRead;
  acting: Acting;
  now: number;
  timeZone?: string;
  /** *On the record*'s *Review*: opens the record sheet. */
  onReview?: () => void;
};

type Open =
  | { id: string; kind: 'reason'; ask: ReasonAsk }
  | { id: string; kind: 'suspend'; extend: boolean }
  | { id: string; kind: 'bounty' }
  | { id: string; kind: 'role'; item: RoleItem };

export function LeverBlock({
  title,
  rows,
  person,
  acting,
  now,
  timeZone,
  onReview,
}: LeverBlockProps) {
  const level = useSectionLevel();
  const region = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  // The dialog stays drawn while it closes, so its words don't blank mid-fade; each opening is a
  // fresh mount (its `serial`), so nothing typed or chosen last time carries over.
  const [shown, setShown] = useState<(Open & { serial: number }) | null>(null);
  const show = (next: Open) => {
    setShown((prev) => ({ ...next, serial: (prev?.serial ?? 0) + 1 }));
    setOpen(true);
  };

  const run = (id: string, action: PersonAction, inline: boolean) =>
    acting.act(id, action, { region: region.current, inline });

  const button = (b: LeverButton) => {
    // The key goes on the outermost element directly: a key spread into JSX is a React warning.
    const common = {
      size: 'sm' as const,
      'data-lever-button': b.id,
    };
    if ('refused' in b) {
      return (
        <Tooltip key={b.id}>
          <TooltipTrigger
            render={
              <Button {...common} disabled focusableWhenDisabled>
                {b.label}
              </Button>
            }
          />
          <TooltipContent title={b.refused.title} side="bottom" align="end">
            {b.refused.body}
          </TooltipContent>
        </Tooltip>
      );
    }
    const busy = acting.busy === b.id;
    const opens = b.opens;
    if (opens.kind === 'roleMenu') {
      return (
        <DropdownMenu key={b.id}>
          <DropdownMenuTrigger
            render={
              <Button {...common} loading={busy}>
                {b.label}
                <DropdownMenuCaret />
              </Button>
            }
          />
          <DropdownMenuContent align="end" data-slot="role-menu">
            <DropdownMenuItem disabled label={ROLE_WORDS[person.role]}>
              <span className="flex items-center justify-between gap-(--space-4)">
                {ROLE_WORDS[person.role]}
                <span className="font-(family-name:--family-mono) text-kick text-fg3">current</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {opens.items.map((item) => (
              <DropdownMenuItem
                key={item.role}
                label={item.label}
                data-role={item.role}
                // A note under the label makes the row two lines tall.
                className={item.note !== null ? 'h-auto py-(--space-1_5)' : undefined}
                onClick={() => {
                  // A demotion asks why; making an admin asks a plain confirm; a moderator, nothing.
                  if (item.needsReason || item.confirm) show({ id: b.id, kind: 'role', item });
                  else void run(b.id, { kind: 'role', role: item.role }, true);
                }}
              >
                <span className="flex flex-col gap-(--space-1)">
                  {item.label}
                  {item.note !== null && (
                    <small
                      data-slot="role-note"
                      className="text-assist leading-none font-regular text-warn"
                    >
                      {item.note}
                    </small>
                  )}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }
    return (
      <Button
        key={b.id}
        {...common}
        variant={b.danger === true ? 'danger' : 'outline'}
        loading={busy}
        onClick={() => {
          switch (opens.kind) {
            case 'now':
              void run(b.id, opens.action, true);
              break;
            case 'reason':
              show({ id: b.id, kind: 'reason', ask: opens.ask });
              break;
            case 'suspend':
              show({ id: b.id, kind: 'suspend', extend: opens.extend });
              break;
            case 'bounty':
              show({ id: b.id, kind: 'bounty' });
              break;
          }
        }}
      >
        {b.label}
      </Button>
    );
  };

  const close = (o: boolean) => {
    if (!o) setOpen(false);
  };

  return (
    <Section
      ref={region}
      level={level}
      title={title}
      tabIndex={-1}
      className="outline-none"
      data-slot={`levers-${title.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <LeverList>
        {rows.map((row) => {
          // The page's own note for a press that waited behind another change: never a server's words.
          const waited = row.buttons.some((b) => acting.waits.has(b.id));
          const action =
            row.review === true ? (
              // *Review* opens the record sheet over the page — drawn only where it can.
              onReview === undefined ? null : (
                <Button size="sm" data-lever-button="record" onClick={onReview}>
                  {WORDS.review}
                </Button>
              )
            ) : row.buttons.length === 0 ? null : row.joined === true ? (
              <ButtonGroup aria-label={row.label}>{row.buttons.map(button)}</ButtonGroup>
            ) : (
              <span className="flex items-center gap-(--space-2)">{row.buttons.map(button)}</span>
            );
          const detail =
            row.second !== undefined || waited ? (
              <>
                {row.second !== undefined && <span className="block">{row.second}</span>}
                {waited && (
                  <span role="alert" data-slot="lever-waited" className="block text-bad">
                    {WORDS.anotherOnItsWay}
                  </span>
                )}
              </>
            ) : undefined;
          return (
            <LeverRow
              key={row.key}
              data-lever={row.key}
              label={row.label}
              status={row.status}
              tone={row.tone}
              action={action}
              detail={detail}
            />
          );
        })}
      </LeverList>

      {shown?.kind === 'reason' && (
        <AskDialog
          key={shown.serial}
          open={open}
          onOpenChange={close}
          title={shown.ask.title}
          description={shown.ask.description}
          confirm={shown.ask.confirm}
          reason
          destructive={shown.ask.destructive === true}
          onConfirm={(reason) => run(shown.id, shown.ask.action(reason), false)}
        />
      )}
      {shown?.kind === 'role' && (
        <AskDialog
          key={shown.serial}
          open={open}
          onOpenChange={close}
          title={WORDS.roleTitle(shownName(person), ROLE_ARTICLE[shown.item.role])}
          description={
            !shown.item.needsReason
              ? WORDS.makeAdminBody
              : shown.item.note !== null
                ? WORDS.demoteWithLedgerBody(ROLE_WORDS[person.role].toLowerCase())
                : WORDS.demoteBody(ROLE_WORDS[person.role].toLowerCase())
          }
          confirm={shown.item.label}
          reason={shown.item.needsReason}
          onConfirm={(reason) =>
            run(
              shown.id,
              {
                kind: 'role',
                role: shown.item.role,
                ...(shown.item.needsReason && { reason }),
              },
              false,
            )
          }
        />
      )}
      {shown?.kind === 'suspend' && (
        <SuspendDialog
          key={shown.serial}
          open={open}
          onOpenChange={close}
          name={shownName(person)}
          extend={shown.extend}
          until={person.statusNote?.suspendedUntil ?? null}
          replacesBan={person.status === 'banned'}
          now={now}
          {...(timeZone !== undefined && { timeZone })}
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
      {shown?.kind === 'bounty' && (
        <BountyDialog
          key={shown.serial}
          open={open}
          onOpenChange={close}
          name={shownName(person)}
          current={person.rights.bountyLimit}
          defaultLimit={person.rights.defaultBountyLimit}
          onConfirm={({ limit, reason }) =>
            run(shown.id, { kind: 'bountyLimit', limit, ...(reason !== '' && { reason }) }, false)
          }
        />
      )}
    </Section>
  );
}
