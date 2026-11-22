import { MAX_REQUEST_NOTE_LENGTH } from '@skating/core';
import {
  type ComponentProps,
  cloneElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useState,
} from 'react';

import { ActionBar, type ActionBarItem } from '@/components/kit/action-bar';
import { buttonVariants } from '@/components/kit/button';
import { DisplayWord } from '@/components/kit/display-word';
import { FactList } from '@/components/kit/fact-list';
import { Note } from '@/components/kit/note';
import { Section } from '@/components/kit/section-slug';
import { ageInWords } from '@/lib/ages';
import { cn } from '@/lib/utils';

import { AskDialog } from '../../../people/person/AskDialog';
import {
  InspectorHeadAge,
  InspectorHeadEnd,
  InspectorHeadTitle,
} from '../../inspector/InspectorFrame';
import { AskList } from '../asks/AskList';
import {
  bodyKicker,
  bodyRows,
  catalogRows,
  headAge,
  headTitle,
  ifBlocks,
  noMatchRows,
  type RequestBarItem,
  type RequestItem,
  type RequestVerb,
  type RequestWrite,
  type Row,
  refusalNote,
  requestBar,
  subjectOf,
} from './requestModel';
import { REQUEST_HANDLER_WORDS as W } from './requestWords';

/**
 * **Board 2.3 and the request kinds derived from it, drawn from props** — the request handler's three
 * slots for the inspector frame:
 *
 * - **`RequestHead`** — the kind's kicker (*Admit a body*, *Activation*, …), *Asked by 2 · 3 days ago*,
 *   and *Open in Body →* (live: the body's page) for a request on a body we hold.
 * - **`RequestBody`** — a request on a body: the body's line and name; then the map slot; then *The
 *   ask* (the shared `AskList`) beside *The catalog* (an admit: the matched feature, or why the
 *   lookup found none) or *The body*; then what approving and what declining each does.
 * - **`RequestActions`** — the bar: the kind's approval (*Admit* A, *Activate* A, *Restore* R,
 *   *Confirm accessible* C, *Take it down* T — red, its reason asked), or *Look up again* (L) for an
 *   admit with no catalog match, then *Decline* (D, its note asked). A button is drawn only where the
 *   item's `can` allows it; a refusal is said in the body, never drawn as a button.
 *
 * No reads, no writes: the container (`RequestHandler`) binds them. A write's refusal is the shell's
 * toast, never printed here (D268).
 */

export type RequestViewProps = {
  item: RequestItem;
  now: number;
  /** The map slot: `ItemMap` in the app, a still in a story; a map with nothing to draw collapses. */
  map: ReactNode;
  /** The link into the body's page (the router's `Link`), unstyled; `null` for an admit (no body). */
  bodyLink: ReactElement | null;
  /** Sends a lever's write; resolves whether it landed (a dialog closes on `true`). */
  onWrite: (write: RequestWrite) => Promise<boolean>;
  /** The inspector pane: the bar's keys act only while focus is inside it. */
  pane?: RefObject<HTMLElement | null>;
};

const KICK = 'text-kick leading-none font-semibold tracking-kick uppercase text-fg3';
const MICRO =
  'font-(family-name:--family-mono) text-kick leading-none tracking-micro whitespace-nowrap text-fg3 uppercase';

// ── Head ─────────────────────────────────────────────────────────────────────────────────────

/** *Open in Body →*: the router's link in the kit's link face. */
function OpenInBody({ link }: { link: ReactElement }) {
  return cloneElement(
    link as ReactElement<ComponentProps<'a'>>,
    {
      'data-slot': 'open-in-body',
      className: cn(buttonVariants({ variant: 'link', size: 'xs' }), 'no-underline'),
      children: (
        <span data-slot="label" className="inline-flex items-center gap-[inherit]">
          {W.openInBody}
          <span aria-hidden="true" className="-mr-[3px]">
            →
          </span>
        </span>
      ),
    } as ComponentProps<'a'>,
  );
}

export function RequestHead({
  item,
  now,
  bodyLink,
}: Pick<RequestViewProps, 'item' | 'now' | 'bodyLink'>) {
  return (
    <>
      <InspectorHeadTitle>{headTitle(item.requestKind)}</InspectorHeadTitle>
      <InspectorHeadAge>{headAge(item, ageInWords(item.filedAt, now))}</InspectorHeadAge>
      {bodyLink !== null && (
        <InspectorHeadEnd>
          <OpenInBody link={bodyLink} />
        </InspectorHeadEnd>
      )}
    </>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────────────────────

function Facts({ rows, ...props }: { rows: Row[] } & Omit<ComponentProps<'dl'>, 'children'>) {
  return (
    <FactList
      {...props}
      rows={rows.map((r) => ({
        label: r.label,
        value: r.mono ? (
          <span className="font-(family-name:--family-mono) text-mono-sm">{r.value}</span>
        ) : (
          r.value
        ),
      }))}
    />
  );
}

/** Two blocks side by side on a wide pane, one over the other on a narrow one. */
function Part({ children, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      className="grid grid-cols-1 gap-x-(--space-7) gap-y-(--space-6) px-(--space-5) pt-(--space-5) pb-(--space-2) @[40rem]:grid-cols-2"
    >
      {children}
    </div>
  );
}

/** What the item says in place of the levers it refuses (the server's sentences). */
function Refusals({ item }: { item: RequestItem }) {
  const said = refusalNote(item);
  if (said === null) return null;
  return (
    <div className="px-(--space-5) pt-(--space-5)">
      <Note data-slot="request-refusals" tone="warn">
        {said.lead !== null && <strong className="block">{said.lead}</strong>}
        {said.lines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </Note>
    </div>
  );
}

export function RequestBody({ item, now, map }: Pick<RequestViewProps, 'item' | 'now' | 'map'>) {
  const ifs = ifBlocks(item);
  const body = item.body;
  return (
    <div data-slot="request-handler" data-kind={item.requestKind} className="@container">
      {body !== null && (
        <div className="flex min-w-0 flex-col gap-(--space-1_5) px-(--space-5) pt-(--space-4) pb-(--space-4)">
          <span data-slot="request-body-kicker" className={KICK}>
            {bodyKicker(body)}
          </span>
          <h2 className="m-0 min-w-0">
            <DisplayWord size="column" className="block truncate">
              {body.name}
            </DisplayWord>
          </h2>
        </div>
      )}
      {/* Empty when the map draws nothing: the slot and its rule go with it. */}
      <div
        data-slot="request-map"
        className={cn(
          'border-0 border-b-(length:--stroke-hair) border-solid border-line empty:hidden',
          body !== null && 'border-t-(length:--stroke-hair)',
        )}
      >
        {map}
      </div>
      <Refusals item={item} />
      <Part>
        <Section
          title={W.theAsk}
          data-slot="request-asks"
          end={<span className={MICRO}>{W.people(item.memberCount, item.memberCountIsFloor)}</span>}
        >
          <AskList
            asks={item.asks}
            now={now}
            total={{ count: item.memberCount, floor: item.memberCountIsFloor }}
          />
        </Section>
        {item.requestKind === 'admit' ? (
          <Section title={W.theCatalog} data-slot="request-catalog">
            <Facts
              rows={item.candidate !== null ? catalogRows(item.candidate, now) : noMatchRows(item)}
            />
          </Section>
        ) : body !== null ? (
          <Section title={W.theBody} data-slot="request-body">
            <Facts rows={bodyRows(body)} />
          </Section>
        ) : null}
      </Part>
      <Part>
        <Section title={ifs.first.title} data-slot="request-if-first">
          <Facts rows={ifs.first.rows} />
        </Section>
        <Section title={ifs.declined.title} data-slot="request-if-declined">
          <Facts rows={ifs.declined.rows} />
        </Section>
      </Part>
    </div>
  );
}

// ── The bar ──────────────────────────────────────────────────────────────────────────────────

/** The dialog a lever opens before it sends: a decline's note, a takedown's reason. */
type Asking = RequestBarItem & { asks: 'note' | 'reason' };

export function RequestActions({
  item,
  onWrite,
  pane,
}: Pick<RequestViewProps, 'item' | 'onWrite' | 'pane'>) {
  const [asking, setAsking] = useState<Asking | null>(null);
  const [open, setOpen] = useState(false);
  const [serial, setSerial] = useState(0);
  const [busy, setBusy] = useState<RequestVerb | null>(null);
  const bar = requestBar(item);
  if (bar.length === 0) return null;

  const run = async (verb: RequestVerb, write: RequestWrite): Promise<boolean> => {
    setBusy(verb);
    try {
      return await onWrite(write);
    } catch {
      // The write path says every refusal itself; a throw past it changed nothing.
      return false;
    } finally {
      setBusy(null);
    }
  };

  const press = (b: RequestBarItem) => {
    // One write at a time.
    if (busy !== null) return;
    if (b.asks === null) {
      void run(b.verb, b.verb === 'lookUpAgain' ? { kind: 'lookUpAgain' } : { kind: 'approve' });
      return;
    }
    setAsking(b as Asking);
    setSerial((s) => s + 1);
    setOpen(true);
  };

  const subject = subjectOf(item);
  const items: ActionBarItem[] = bar.map((b) => ({
    id: b.verb,
    label: b.label,
    hotkey: b.hotkey,
    what: b.what,
    onPress: () => press(b),
    danger: b.danger,
    loading: busy === b.verb,
    disabled: busy !== null && busy !== b.verb,
  }));

  return (
    <>
      <ActionBar
        data-slot="request-actions"
        aria-label={W.bar}
        groups={[{ id: 'request', items }]}
        {...(pane !== undefined && { pane })}
      />
      {asking !== null && (
        <AskDialog
          key={serial}
          open={open}
          onOpenChange={setOpen}
          title={asking.verb === 'decline' ? W.declineTitle(subject) : W.takedownTitle(subject)}
          description={asking.verb === 'decline' ? W.declineBody : W.takedownBody}
          confirm={asking.label}
          reason
          reasonLabel={asking.asks === 'note' ? W.noteLabel : W.reasonLabel}
          // The asker reads it: the request note's server cap, so an over-long one is stopped here.
          maxLength={MAX_REQUEST_NOTE_LENGTH}
          destructive={asking.verb === 'approve'}
          onConfirm={async (typed) => {
            const write: RequestWrite =
              asking.verb === 'decline'
                ? { kind: 'decline', note: typed }
                : { kind: 'approve', note: typed };
            return (await run(asking.verb, write)) ? 'landed' : 'refused';
          }}
        />
      )}
    </>
  );
}

/** The three slots the inspector frame takes (`InspectorFrame`'s `head`, `actions`, children). */
export function requestSlots(props: RequestViewProps): {
  head: ReactNode;
  actions: ReactNode;
  body: ReactNode;
} {
  return {
    head: <RequestHead item={props.item} now={props.now} bodyLink={props.bodyLink} />,
    actions: (
      <RequestActions
        item={props.item}
        onWrite={props.onWrite}
        {...(props.pane !== undefined && { pane: props.pane })}
      />
    ),
    body: <RequestBody item={props.item} now={props.now} map={props.map} />,
  };
}
