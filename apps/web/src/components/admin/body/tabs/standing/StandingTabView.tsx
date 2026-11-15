import {
  type BodyStanding,
  describeStanding,
  REMOVAL_REASONS,
  type RemovalReason,
  standingReasonLabel,
} from '@skating/core';
import { type ComponentProps, type FormEvent, useId, useRef, useState } from 'react';

import { Badge } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { Input, InputGroup, InputGroupKbd } from '@/components/kit/input';
import { Kbd } from '@/components/kit/kbd';
import { LaneTimeline } from '@/components/kit/lane-timeline';
import { RadioGroup, RadioRow } from '@/components/kit/radio';
import { RetryNote } from '@/components/kit/retry-note';
import { Section } from '@/components/kit/section-slug';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/kit/select';
import { cn } from '@/lib/utils';
import { REMOVAL_REASON_WORDS, statusDate } from '../../frame/bodyModel';
import { LoadingSection } from '../tabParts';
import { type RetentionFacts, retentionModel } from './standingModel';

/**
 * Board 5.4.8, Body › Standing, the default view: where the body stands, as radios — the current
 * one wearing **Now** — and, for an active body, **what keeps it active** at each 1 July rollover.
 *
 * Picking another standing moves the pick; its form opens under the list with a button that names
 * it. Nothing is written until that button is pressed. Everything shown arrives as props; the
 * wiring (`StandingTab`) reads and writes.
 *
 * **Standing is not a statement about ice.** Active means on the map and in search; it says
 * nothing about whether anyone should skate there (D3).
 */

type Pick = 'active' | 'dormant' | 'removed';

export type StandingTabViewProps = Omit<ComponentProps<'div'>, 'children'> & {
  standing: BodyStanding;
  /** When an active body last became active; `null` when the record doesn't say. */
  activeSince: number | null;
  /**
   * What the retention rule reads, for an active body: the facts, `undefined` while the read is on
   * its way, `'error'` when it failed.
   */
  retention: RetentionFacts | undefined | 'error';
  /** Read again after a failure. Absent: no *Try again*. */
  onRetry?: () => void;
  /** The failed reads were tried again; their fresh answers aren't in. */
  retryPending?: boolean;
  now: number;
  /** The viewer holds `body.standing` (set dormant, bring back). */
  canSetStanding: boolean;
  /** The viewer holds `body.remove` (take off the map, restore). */
  canRemove: boolean;
  onSetDormant?: (note: string) => Promise<void>;
  onSetActive?: () => Promise<void>;
  onRemove?: (reason: RemovalReason) => Promise<void>;
  onRestore?: () => Promise<void>;
};

/** A standing note's ceiling — the server's (`MAX_STANDING_NOTE_LENGTH`). */
export const STANDING_NOTE_MAX = 160;

/** "17 Sep 2026" — a status date carries its year (the frame's `statusDate`). */
const sinceWords = (at: number): string => statusDate(at);

const REMOVAL_LABEL = REMOVAL_REASON_WORDS;

/** The radio a standing is drawn on (unlisted has none: it isn't a choice). */
function currentPick(s: BodyStanding): Pick | null {
  return s.standing === 'unlisted' ? null : s.standing;
}

export function StandingTabView({
  standing,
  activeSince,
  retention,
  onRetry,
  retryPending = false,
  now,
  canSetStanding,
  canRemove,
  onSetDormant,
  onSetActive,
  onRemove,
  onRestore,
  className,
  ...props
}: StandingTabViewProps) {
  const current = currentPick(standing);
  const [pick, setPick] = useState<Pick | null>(current);
  // A write that lands moves the standing; the pick follows it back to Now.
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    setPick(current);
  }

  const onAccessRuling = standing.standing === 'dormant' && standing.reason === 'no_public_access';
  // What the viewer may move to from here. A removal is undone only by Restore; a `none` access
  // ruling only on Access.
  const reachable: Record<Pick, boolean> = {
    active:
      current === 'active' ||
      (current === 'dormant' && !onAccessRuling && canSetStanding && onSetActive !== undefined) ||
      (current === 'removed' && canRemove && onRestore !== undefined),
    dormant:
      current === 'dormant' ||
      (current === 'active' && canSetStanding && onSetDormant !== undefined),
    removed: current === 'removed' || (canRemove && onRemove !== undefined),
  };

  return (
    <div
      data-slot="standing-tab"
      className={cn('flex flex-col gap-(--space-5_5)', className)}
      {...props}
    >
      <Section title="Standing">
        {current === null ? (
          <p className="m-0 text-row text-fg2">
            Not on the map: rejected, or merged into another body.
          </p>
        ) : (
          <RadioGroup
            aria-label="Standing"
            value={pick}
            onValueChange={(value) => setPick(value as Pick)}
          >
            <StandingOption
              value="active"
              name="Active"
              now={current === 'active'}
              meaning="On the map, in search and in notifications"
              since={
                current === 'active' && activeSince !== null
                  ? `Since ${sinceWords(activeSince)}`
                  : null
              }
              disabled={!reachable.active}
            />
            <StandingOption
              value="dormant"
              name="Dormant"
              now={current === 'dormant'}
              meaning="Drawn only when zoomed in on it, dimmed. Search marks it Inactive."
              since={
                standing.standing === 'dormant'
                  ? `Since ${sinceWords(standing.since)} · ${standingReasonLabel(standing.reason)}`
                  : null
              }
              disabled={!reachable.dormant}
            />
            {(canRemove || current === 'removed') && (
              <StandingOption
                value="removed"
                name="Removed"
                now={current === 'removed'}
                meaning="Drawn only when zoomed in on it. Never in search."
                since={
                  standing.standing === 'removed'
                    ? `Since ${sinceWords(standing.since)} · ${REMOVAL_LABEL[standing.reason]}`
                    : null
                }
                disabled={!reachable.removed}
              />
            )}
          </RadioGroup>
        )}
        {standing.standing !== 'active' && describeStanding(standing) !== null && (
          <p
            data-slot="standing-skater-line"
            className="m-0 text-assist leading-(--lead-list) text-fg3"
          >
            Skaters read “{describeStanding(standing)}”
          </p>
        )}
        {onAccessRuling && (
          <p className="m-0 text-assist leading-(--lead-list) text-fg3">
            Dormant on the access ruling; it changes on Access.
          </p>
        )}
        {pick !== null && pick !== current && (
          <PickForm
            pick={pick}
            current={current}
            onSetDormant={onSetDormant}
            onSetActive={onSetActive}
            onRemove={onRemove}
            onRestore={onRestore}
          />
        )}
      </Section>

      {standing.standing === 'active' &&
        (retention === undefined ? (
          <Section title="What keeps it active" data-slot="standing-retention" aria-busy="true">
            <LoadingSection lines={3} />
          </Section>
        ) : retention === 'error' ? (
          <Section title="What keeps it active" data-slot="standing-retention">
            <RetryNote onRetry={onRetry} pending={retryPending}>
              What keeps it active couldn’t be read
            </RetryNote>
          </Section>
        ) : (
          <Retention facts={retention} now={now} />
        ))}
    </div>
  );
}

function StandingOption({
  value,
  name,
  now,
  meaning,
  since,
  disabled,
}: {
  value: Pick;
  name: string;
  now: boolean;
  meaning: string;
  since: string | null;
  disabled: boolean;
}) {
  return (
    <RadioRow
      value={value}
      disabled={disabled}
      data-now={now ? '' : undefined}
      className="py-(--space-2_5)"
      label={
        <span className="flex items-center gap-(--space-2_5)">
          {name}
          {now && (
            <Badge variant="outline" tone="lit">
              Now
            </Badge>
          )}
        </span>
      }
      description={
        <span className="flex flex-col gap-(--space-1)">
          <span>{meaning}</span>
          {since !== null && <span data-slot="standing-since">{since}</span>}
        </span>
      }
    />
  );
}

/** The pick's form: what it does, and the one button that does it. */
function PickForm({
  pick,
  current,
  onSetDormant,
  onSetActive,
  onRemove,
  onRestore,
}: {
  pick: Pick;
  current: Pick | null;
  onSetDormant: StandingTabViewProps['onSetDormant'];
  onSetActive: StandingTabViewProps['onSetActive'];
  onRemove: StandingTabViewProps['onRemove'];
  onRestore: StandingTabViewProps['onRestore'];
}) {
  const noteId = useId();
  const [note, setNote] = useState('');
  const [reason, setReason] = useState<RemovalReason | null>(null);
  const [busy, setBusy] = useState(false);
  // A refusal belongs to the pick whose write raised it: the form is one component across picks,
  // so another pick's form never says it.
  const [refusal, setRefusal] = useState<{ pick: Pick; text: string } | null>(null);
  const error = refusal?.pick === pick ? refusal.text : null;

  // One write at a time (⏎ in the note submits the form again otherwise), so each answer is the
  // only attempt's.
  const sending = useRef(false);
  async function run(write: () => Promise<void>) {
    if (sending.current) return;
    sending.current = true;
    const raisedFor = pick;
    setBusy(true);
    setRefusal(null);
    try {
      await write();
    } catch (err) {
      setRefusal({ pick: raisedFor, text: err instanceof Error ? err.message : String(err) });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  if (pick === 'dormant' && onSetDormant) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      void run(() => onSetDormant(note.trim()));
    };
    return (
      <form data-slot="standing-form" onSubmit={submit} className="flex flex-col gap-(--space-2)">
        <span className="flex items-baseline justify-between">
          <label
            htmlFor={noteId}
            className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase"
          >
            Note for skaters · optional
          </label>
          <span
            data-slot="standing-note-count"
            className="font-(family-name:--family-mono) text-kick leading-none text-fg3 tabular-nums"
          >
            {note.length} / {STANDING_NOTE_MAX}
          </span>
        </span>
        <InputGroup>
          <Input
            id={noteId}
            value={note}
            maxLength={STANDING_NOTE_MAX}
            placeholder="Drawn down for dam work until January"
            // A sent note is held while its write is out: words typed then could never be sent.
            readOnly={busy}
            onChange={(e) => setNote(e.target.value)}
          />
          <InputGroupKbd>⏎</InputGroupKbd>
        </InputGroup>
        <span className="text-assist leading-(--lead-list) text-fg3">
          Skaters read it after “A moderator set this lake inactive:”
        </span>
        <FormError error={error} />
        <Button type="submit" loading={busy} className="self-start">
          Set dormant <Kbd variant="dim">⏎</Kbd>
        </Button>
      </form>
    );
  }

  if (pick === 'removed' && onRemove) {
    return (
      <div data-slot="standing-form" className="flex flex-col gap-(--space-2)">
        <span className="text-kick leading-none font-semibold tracking-kick text-fg3 uppercase">
          Reason
        </span>
        <Select
          value={reason}
          // The sent reason is held while its write is out (a pick then could never be sent).
          readOnly={busy}
          onValueChange={(v) => setReason(v as RemovalReason)}
          items={REMOVAL_REASONS.map((r) => ({ value: r, label: REMOVAL_LABEL[r] }))}
        >
          <SelectTrigger aria-label="Reason">
            <SelectValue placeholder="Choose a reason" />
          </SelectTrigger>
          <SelectContent>
            {REMOVAL_REASONS.map((r) => (
              <SelectItem key={r} value={r}>
                {REMOVAL_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {reason !== null && (
          <span className="text-assist leading-(--lead-list) text-fg3">
            Skaters read “{describeStanding({ standing: 'removed', since: 0, reason })}”
          </span>
        )}
        <FormError error={error} />
        {/* Inert until there is a reason (Review 14 #10): armed, waiting. */}
        <Button
          variant="danger"
          armed
          disabled={reason === null}
          loading={busy}
          className="self-start"
          onClick={() => {
            if (reason !== null) void run(() => onRemove(reason));
          }}
        >
          Remove from the map
        </Button>
      </div>
    );
  }

  const back = current === 'removed' ? onRestore : onSetActive;
  if (pick === 'active' && back) {
    return (
      <div data-slot="standing-form" className="flex flex-col gap-(--space-2)">
        <FormError error={error} />
        <Button loading={busy} className="self-start" onClick={() => void run(back)}>
          {current === 'removed' ? 'Restore to the map' : 'Bring back to the active map'}
        </Button>
      </div>
    );
  }
  return null;
}

function FormError({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="m-0 text-assist text-bad">
      {error}
    </p>
  );
}

/** What keeps it active: one lane per reason that holds, on the years ahead. */
function Retention({ facts, now }: { facts: RetentionFacts; now: number }) {
  const model = retentionModel(facts, now);
  return (
    <Section title="What keeps it active" data-slot="standing-retention">
      {model.lanes.length > 0 && (
        <LaneTimeline
          start={model.start}
          end={model.end}
          axisLabel="Rollovers"
          gridlines={model.rollovers}
          lanes={model.lanes}
        />
      )}
      {model.foot !== '' && (
        <p data-slot="standing-foot" className="m-0 text-assist leading-(--lead-list) text-fg3">
          {model.foot}
        </p>
      )}
      {model.notRecorded !== null && (
        <p
          data-slot="standing-not-recorded"
          className="m-0 text-assist leading-(--lead-list) text-fg3"
        >
          Not recorded yet: {model.notRecorded}.
        </p>
      )}
    </Section>
  );
}
