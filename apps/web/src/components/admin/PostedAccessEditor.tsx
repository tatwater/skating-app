import { api } from '@skating/convex/api';
import type { Doc, Id } from '@skating/convex/dataModel';
import {
  describePostedAccess,
  formatMinuteOfDay,
  type PostedAccess,
  type PostedDailyWindow,
  postedAccessError,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { useState } from 'react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

type Banner = { tone: 'ok' | 'error'; text: string } | null;

/** Turn a thrown ConvexError into the operator-facing line the server wrote. */
function errorText(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string } | string;
    return typeof data === 'string' ? data : (data?.message ?? 'That write was rejected.');
  }
  return 'Something went wrong — check your connection and try again.';
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

type TargetKey = string;
type Target =
  | {
      key: TargetKey;
      label: string;
      rule?: PostedAccess;
      arg: { type: 'waterbody'; id: Id<'waterBodies'> };
    }
  | { key: TargetKey; label: string; rule?: PostedAccess; arg: { type: 'putIn'; id: Id<'putIns'> } }
  | {
      key: TargetKey;
      label: string;
      rule?: PostedAccess;
      arg: { type: 'parkingArea'; id: Id<'parkingAreas'> };
    };

/**
 * Type in what a posted sign says (N6e) — for the lake, or for any one of its launches or lots.
 *
 * **One card with a target selector, rather than a form inlined into each access row.** Champlain
 * carries 160 parking areas; a per-row editor would render that form 160 times for a field expected on
 * a handful of them. The selector also makes the composition rule visible in the UI itself: you pick
 * the thing the sign is nailed to, and nothing offers to apply one rule to several.
 *
 * Moderator-only, and deliberately not a community surface. A wrong "open 24 hours" sends a stranger
 * somewhere they are not allowed to be, which is not a thing a vote makes safe.
 */
export function PostedAccessTool({
  body,
  onResult,
}: {
  body: Doc<'waterBodies'>;
  onResult: (banner: Banner) => void;
}) {
  const access = useQuery(api.accessPoints.accessForBody, { waterBodyId: body._id });
  const setPostedAccess = useMutation(api.postedAccess.setPostedAccess);
  const [targetKey, setTargetKey] = useState<TargetKey>('body');
  const [busy, setBusy] = useState(false);

  const targets: Target[] = [
    {
      key: 'body',
      label: `The lake — ${body.name ?? 'unnamed'}`,
      rule: body.postedAccess,
      arg: { type: 'waterbody', id: body._id },
    },
    ...(access?.putIns ?? []).map(
      (p): Target => ({
        key: `putIn:${p.id}`,
        label: `Launch — ${p.name ?? 'unnamed'}`,
        rule: p.postedAccess,
        arg: { type: 'putIn', id: p.id as Id<'putIns'> },
      }),
    ),
    ...(access?.parking ?? []).map(
      (p): Target => ({
        key: `lot:${p.id}`,
        label: `Parking — ${p.name ?? 'unnamed'}`,
        rule: p.postedAccess,
        arg: { type: 'parkingArea', id: p.id as Id<'parkingAreas'> },
      }),
    ),
  ];
  const target = targets.find((t) => t.key === targetKey) ?? targets[0];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="posted-target">This sign is posted on</Label>
        <select
          id="posted-target"
          className="rounded border border-border bg-surface px-2 py-1 text-sm"
          value={target?.key}
          onChange={(e) => setTargetKey(e.target.value)}
        >
          {targets.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
              {t.rule ? ' ✓' : ''}
            </option>
          ))}
        </select>
      </div>

      {target ? (
        // Keyed on the target so switching reloads the form from that target's stored rule rather than
        // carrying the previous one's values across — the same hazard `DepthTool`'s resync guards
        // against, solved here by remounting because the whole form is the value.
        <PostedAccessFields
          key={target.key}
          initial={target.rule}
          busy={busy}
          onSave={async (rule) => {
            setBusy(true);
            try {
              await setPostedAccess({ target: target.arg, postedAccess: rule });
              onResult({
                tone: 'ok',
                text: rule ? `Posted rules saved for ${target.label}.` : 'Posted rules cleared.',
              });
            } catch (err) {
              onResult({ tone: 'error', text: errorText(err) });
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      <p className="text-foreground-muted text-xs">
        What a sign actually says — a seasonal window, daily hours, a permit. Entered by hand and
        never imported: this is a legal restriction, so it carries a name and an audit row rather
        than a vote. A rule on a lot says nothing about the lake, or about the lot beside it.
      </p>
    </div>
  );
}

/** The form itself. Split out so the target selector above owns *which* row, and this owns the value. */
function PostedAccessFields({
  initial,
  busy,
  onSave,
}: {
  initial?: PostedAccess;
  busy: boolean;
  onSave: (rule: PostedAccess | null) => Promise<void>;
}) {
  const [seasonal, setSeasonal] = useState(initial?.dateRange !== undefined);
  const [startMonth, setStartMonth] = useState(initial?.dateRange?.startMonth ?? 1);
  const [startDay, setStartDay] = useState(initial?.dateRange?.startDay ?? 1);
  const [endMonth, setEndMonth] = useState(initial?.dateRange?.endMonth ?? 3);
  const [endDay, setEndDay] = useState(initial?.dateRange?.endDay ?? 15);

  const [windowKind, setWindowKind] = useState<'none' | 'daylight' | 'clock'>(
    initial?.dailyWindow?.kind ?? 'none',
  );
  const [offsetMinutes, setOffsetMinutes] = useState(
    initial?.dailyWindow?.kind === 'daylight' ? initial.dailyWindow.offsetMinutes : 0,
  );
  const [openMinute, setOpenMinute] = useState(
    initial?.dailyWindow?.kind === 'clock' ? initial.dailyWindow.openMinute : 6 * 60,
  );
  const [closeMinute, setCloseMinute] = useState(
    initial?.dailyWindow?.kind === 'clock' ? initial.dailyWindow.closeMinute : 20 * 60,
  );

  const [permitRequired, setPermitRequired] = useState(initial?.permitRequired ?? false);
  const [note, setNote] = useState(initial?.note ?? '');

  const dailyWindow: PostedDailyWindow | undefined =
    windowKind === 'daylight'
      ? { kind: 'daylight', offsetMinutes }
      : windowKind === 'clock'
        ? { kind: 'clock', openMinute, closeMinute }
        : undefined;

  const rule: PostedAccess = {
    ...(seasonal ? { dateRange: { startMonth, startDay, endMonth, endDay } } : {}),
    ...(dailyWindow ? { dailyWindow } : {}),
    ...(permitRequired ? { permitRequired } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  };

  // The same validator the mutation runs, so an operator sees the error without a round trip. The
  // server check is the guarantee; this one is the courtesy.
  const error = postedAccessError(rule);
  const preview = describePostedAccess(rule);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id="posted-seasonal"
          checked={seasonal}
          onCheckedChange={(v) => setSeasonal(v === true)}
        />
        <Label htmlFor="posted-seasonal">Only part of the year</Label>
      </div>
      {seasonal ? (
        <div className="flex flex-wrap items-end gap-2 pl-6">
          <MonthDay
            idPrefix="posted-start"
            label="From"
            month={startMonth}
            day={startDay}
            onMonth={setStartMonth}
            onDay={setStartDay}
          />
          <MonthDay
            idPrefix="posted-end"
            label="Through"
            month={endMonth}
            day={endDay}
            onMonth={setEndMonth}
            onDay={setEndDay}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="posted-window">Daily hours</Label>
        <select
          id="posted-window"
          className="rounded border border-border bg-surface px-2 py-1 text-sm"
          value={windowKind}
          onChange={(e) => setWindowKind(e.target.value as 'none' | 'daylight' | 'clock')}
        >
          <option value="none">No daily limit</option>
          <option value="daylight">Daylight hours</option>
          <option value="clock">Fixed clock times</option>
        </select>
      </div>

      {windowKind === 'daylight' ? (
        <div className="flex flex-col gap-1.5 pl-6">
          <Label htmlFor="posted-offset">Minutes either side of sunrise/sunset</Label>
          <Input
            id="posted-offset"
            type="number"
            min="0"
            step="5"
            className="w-24"
            value={offsetMinutes}
            onChange={(e) => setOffsetMinutes(Number(e.target.value))}
          />
          {/* The offset is the reason this isn't a checkbox: "one-half hour before sunrise to one-half
              hour after sunset" is the commonest wording in fish & wildlife regulations. */}
          <p className="text-foreground-muted text-xs">
            0 for a bare “sunrise to sunset”. 30 for “a half hour before sunrise to a half hour
            after sunset”.
          </p>
        </div>
      ) : null}

      {windowKind === 'clock' ? (
        <div className="flex items-end gap-2 pl-6">
          <ClockField id="posted-open" label="Opens" minute={openMinute} onChange={setOpenMinute} />
          <ClockField
            id="posted-close"
            label="Closes"
            minute={closeMinute}
            onChange={setCloseMinute}
          />
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Checkbox
          id="posted-permit"
          checked={permitRequired}
          onCheckedChange={(v) => setPermitRequired(v === true)}
        />
        <Label htmlFor="posted-permit">A permit is required</Label>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="posted-note">Source (shown publicly)</Label>
        <Input
          id="posted-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="NYSDEC; access permit from the City of Troy"
        />
      </div>

      {preview ? (
        <p className="text-foreground-muted text-sm">
          Reads as: <span className="text-foreground">{preview}</span>
        </p>
      ) : null}
      {error ? <p className="text-danger text-xs">{error}</p> : null}

      <div className="flex gap-2">
        <Button size="sm" disabled={busy || error !== null} onClick={() => onSave(rule)}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {/* `null` clears — the same call an empty `setReferenceLinks` array makes, and the only way to
            remove a rule that should never have been posted. */}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onSave(null)}>
          Clear
        </Button>
      </div>
    </div>
  );
}

function MonthDay({
  idPrefix,
  label,
  month,
  day,
  onMonth,
  onDay,
}: {
  idPrefix: string;
  label: string;
  month: number;
  day: number;
  onMonth: (m: number) => void;
  onDay: (d: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${idPrefix}-month`}>{label}</Label>
      <div className="flex gap-1">
        <select
          id={`${idPrefix}-month`}
          className="rounded border border-border bg-surface px-2 py-1 text-sm"
          value={month}
          onChange={(e) => onMonth(Number(e.target.value))}
        >
          {MONTHS.map((name, index) => (
            <option key={name} value={index + 1}>
              {name}
            </option>
          ))}
        </select>
        <Input
          aria-label={`${label} day`}
          type="number"
          min="1"
          max="31"
          className="w-16"
          value={day}
          onChange={(e) => onDay(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

/** An `<input type="time">` bound to minutes-past-midnight, which is how the rule is stored. */
function ClockField({
  id,
  label,
  minute,
  onChange,
}: {
  id: string;
  label: string;
  minute: number;
  onChange: (m: number) => void;
}) {
  const value = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="time"
        className="w-32"
        value={value}
        onChange={(e) => {
          const [h, m] = e.target.value.split(':').map(Number);
          if (h !== undefined && m !== undefined && Number.isFinite(h) && Number.isFinite(m)) {
            onChange(h * 60 + m);
          }
        }}
      />
      <span className="text-foreground-muted text-xs">{formatMinuteOfDay(minute)}</span>
    </div>
  );
}
