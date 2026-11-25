import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ActionBar } from '@/components/kit/action-bar';
import { Badge } from '@/components/kit/badge';
import { must } from '@/components/kit/storyKit';
import { KeysProvider } from '@/lib/keys';

import { storyLink } from '../inbox/inboxBoard';
import type { HandlerKey, InboxHandler } from '../inbox/inspector/handlerRegistry';
import { InboxInspector, type InspectorState } from '../inbox/inspector/InboxInspector';
import {
  ACCESS_ITEM,
  ADMIT_ITEM,
  decidedItem,
  NOW,
  SAFETY_ITEM,
  SARAH,
  TEAGAN,
  TICKET_ITEM,
} from '../inbox/list/inboxFixtures';
import type { InboxItemView } from '../inbox/list/inboxTypes';
import {
  type DecidedState,
  InspectorFrame,
  InspectorHeadAge,
  InspectorHeadTitle,
} from './InspectorFrame';
import { InspectorProvider } from './inspectorContext';

/**
 * The inspector's frame (the canonical seam every handler draws in) and the column around it: the
 * pane head, the scroll, the kit's floating action bar, the decided-only lock (D283) in each of its
 * states, and the placeholder a kind without its handler draws. In the inspector column's own width
 * on the pinned clock.
 */

type FrameArgs = {
  locked: DecidedState | null;
  decidedOnOpen: boolean;
  onBack: () => void;
  onDismiss: () => void;
};

function Column({ locked, decidedOnOpen, onBack, onDismiss }: FrameArgs) {
  const pane = useRef<HTMLElement | null>(null);
  const [log, setLog] = useState<string[]>([]);
  return (
    <KeysProvider>
      <section
        ref={pane}
        data-pane="detail"
        tabIndex={-1}
        aria-label="Item"
        className="relative flex h-[40rem] w-[52rem] flex-col bg-bg outline-none"
      >
        <InspectorProvider value={{ pane, onBack, decidedOnOpen, now: NOW, history: undefined }}>
          <InspectorFrame
            locked={locked}
            head={
              <>
                <InspectorHeadTitle>Unsafe false report</InspectorHeadTitle>
                <Badge variant="outline" tone="bad">
                  safety
                </Badge>
                <InspectorHeadAge>4 days ago</InspectorHeadAge>
              </>
            }
            actions={
              <ActionBar
                aria-label="Flag actions"
                pane={pane}
                groups={[
                  {
                    id: 'flag',
                    label: 'Flag',
                    items: [
                      {
                        id: 'dismiss',
                        label: 'Dismiss',
                        what: 'Closes the flag; the report stays as it is.',
                        onPress: () => {
                          onDismiss();
                          setLog((l) => [...l, 'dismiss']);
                        },
                      },
                    ],
                  },
                ]}
              />
            }
          >
            <p data-slot="story-body" className="m-0 px-gutter pt-(--space-4) text-row text-fg2">
              Black ice over most of the north end, 3½" where I drilled off the town beach.
            </p>
            <output data-slot="story-log" className="block px-gutter text-assist text-fg3">
              {log.join(' ')}
            </output>
          </InspectorFrame>
        </InspectorProvider>
      </section>
    </KeysProvider>
  );
}

const meta = {
  title: 'Admin/Inbox/Inspector frame',
  component: Column,
  globals: { surface: 'admin', mode: 'dark' },
  args: { locked: null, decidedOnOpen: false, onBack: fn(), onDismiss: fn() },
} satisfies Meta<typeof Column>;

export default meta;
type Story = StoryObj<typeof meta>;

const pane = (root: HTMLElement) => must(root.querySelector<HTMLElement>('[data-pane="detail"]'));
const LOCK: DecidedState = {
  by: 'Sarah Berman',
  at: NOW - 18 * 60_000,
  decisionWord: 'approved',
  byMe: false,
  actionId: 'm1',
};

/** Live: the action bar floats at the foot; its key acts only while the inspector has focus. */
export const Live: Story = {
  play: async ({ canvasElement, args }) => {
    const bar = within(canvasElement).getByRole('toolbar', { name: 'Flag actions' });
    await expect(bar).toHaveAttribute('data-floating');
    // The scroll keeps room for the bar at its end.
    const scroll = must(
      canvasElement.querySelector<HTMLElement>('[data-slot="inbox-inspector-scroll"]'),
    );
    await expect(Number.parseFloat(getComputedStyle(scroll).paddingBottom)).toBeGreaterThanOrEqual(
      70,
    );
    // D outside the inspector does nothing; inside it dismisses.
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('d');
    await expect(args.onDismiss).not.toHaveBeenCalled();
    pane(canvasElement).focus();
    await waitFor(() => expect(pane(canvasElement)).toHaveFocus());
    await userEvent.keyboard('d');
    await waitFor(() => expect(args.onDismiss).toHaveBeenCalledTimes(1));
    await expect(canvasElement.querySelector('[data-slot="inbox-decided-lock"]')).toBeNull();
  },
};

/** Decided by a colleague while open: the bar goes; the banner; ⏎ goes back to the queue. */
export const Locked: Story = {
  args: { locked: LOCK },
  play: async ({ canvasElement, args }) => {
    await expect(within(canvasElement).queryByRole('toolbar')).toBeNull();
    const lock = must(canvasElement.querySelector<HTMLElement>('[data-slot="inbox-decided-lock"]'));
    await expect(lock).toHaveTextContent('Decided by Sarah Berman · 11:42 · approved');
    // The lock announces through the kit's live region inside it, which holds the banner's line
    // alone (its words land a frame after mount) — never the buttons.
    const said = within(lock).getByRole('status');
    await waitFor(() =>
      expect(said).toHaveTextContent('Decided by Sarah Berman · 11:42 · approved'),
    );
    await expect(within(said).queryByRole('button')).toBeNull();
    const back = within(lock).getByRole('button', { name: /Back to the queue/ });
    await expect(back).toHaveTextContent('⏎');
    // ⏎ in the pane goes back; a letter does nothing now the item is decided.
    pane(canvasElement).focus();
    await waitFor(() => expect(pane(canvasElement)).toHaveFocus());
    await userEvent.keyboard('d');
    await expect(args.onDismiss).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(args.onBack).toHaveBeenCalledTimes(1));
  },
};

/** The viewer's own decision, made while open: it clears quietly — no bar, and no banner. */
export const Quiet: Story = {
  args: { locked: { ...LOCK, by: 'Teagan Atwater', byMe: true } },
  play: async ({ canvasElement, args }) => {
    await expect(within(canvasElement).queryByRole('toolbar')).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="inbox-decided-lock"]')).toBeNull();
    pane(canvasElement).focus();
    await waitFor(() => expect(pane(canvasElement)).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await expect(args.onBack).not.toHaveBeenCalled();
  },
};

/** Opened already decided (the Decided lane): a record, its decision shown even when the viewer's. */
export const DecidedOnOpen: Story = {
  args: { locked: { ...LOCK, by: 'Teagan Atwater', byMe: true }, decidedOnOpen: true },
  play: async ({ canvasElement }) => {
    await expect(
      must(canvasElement.querySelector('[data-slot="inbox-decided-lock"]')),
    ).toHaveTextContent('Decided by Teagan Atwater');
  },
};

export const LockedLight: Story = {
  args: { locked: LOCK },
  globals: { surface: 'admin', mode: 'light' },
};

// ── The column's states, through InboxInspector ──────────────────────────────────────────────

function Inspector({
  state,
  registry,
}: {
  state: InspectorState;
  /** The handlers by key; the builders' own unless the story is about the frame (an empty map). */
  registry?: ReadonlyMap<HandlerKey, InboxHandler>;
}) {
  const pane = useRef<HTMLElement | null>(null);
  return (
    <KeysProvider>
      <section
        ref={pane}
        data-pane="detail"
        tabIndex={-1}
        className="relative flex h-[34rem] w-[52rem] flex-col bg-bg"
      >
        <InboxInspector
          state={state}
          now={NOW}
          pane={pane}
          onBack={() => {}}
          linkFor={storyLink}
          {...(registry !== undefined && { registry })}
        />
      </section>
    </KeysProvider>
  );
}

const item = (i: InboxItemView): InspectorState => ({ kind: 'item', item: i, phase: 'live' });

/** Each kind without its handler yet draws the placeholder: its facts, read only, no bar. */
export const Placeholders: StoryObj<typeof Inspector> = {
  render: () => (
    <div className="flex flex-col gap-(--space-4)">
      {[SAFETY_ITEM, ACCESS_ITEM, ADMIT_ITEM, TICKET_ITEM].map((i) => (
        <Inspector key={i.itemId} state={item(i)} registry={new Map()} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const facts = [...canvasElement.querySelectorAll('[data-slot="inbox-placeholder-facts"]')];
    await expect(facts).toHaveLength(4);
    await expect(facts[0]).toHaveTextContent('Dangerously false ice report');
    await expect(facts[1]).toHaveTextContent('Tomhannock Reservoir');
    await expect(facts[2]).toHaveTextContent('Admission');
    await expect(facts[3]).toHaveTextContent('I was suspended');
    await expect(canvasElement.querySelector('[role="toolbar"]')).toBeNull();
  },
};

/** The item's History →: a live link to the Body console; Coming soon where it names Reports. */
export const History: StoryObj<typeof Inspector> = {
  render: () => (
    <div className="flex flex-col gap-(--space-4)">
      <Inspector
        registry={new Map()}
        state={{
          kind: 'item',
          item: decidedItem(ACCESS_ITEM, SARAH, 3_600_000, 'ruled_closed'),
          phase: 'locked',
        }}
      />
      <Inspector
        registry={new Map()}
        state={{
          kind: 'item',
          item: decidedItem(SAFETY_ITEM, TEAGAN, 3_600_000, 'dismissed'),
          phase: 'locked',
        }}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const links = [...canvasElement.querySelectorAll<HTMLElement>('[data-slot="inbox-history"]')];
    await expect(links).toHaveLength(2);
    await expect(links[0]?.closest('a') ?? links[0]).toHaveAttribute(
      'href',
      expect.stringContaining('/admin/body/'),
    );
    await expect(links[1]).toHaveAttribute('aria-disabled', 'true');
    // It says so on focus, in its tooltip (and on press, in a toast).
    must(links[1]).focus();
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-title"]')).toHaveTextContent(
        'Coming soon',
      ),
    );
    must(links[1]).blur();
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-title"]')).toBeNull());
  },
};

/** The states that stand in for an item: on its way, failed, not yet prepared, no such item. */
export const States: StoryObj<typeof Inspector> = {
  render: () => (
    <div className="flex flex-col gap-(--space-4)">
      <Inspector state={{ kind: 'loading' }} />
      <Inspector state={{ kind: 'failed', retry: () => {}, retrying: false }} />
      <Inspector state={{ kind: 'pending' }} />
      <Inspector state={{ kind: 'missing' }} />
      <Inspector
        state={{ kind: 'refused', words: 'Support tickets are read only by staff who answer them' }}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-slot="inbox-item-loading"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-slot="inbox-item-error"]')).toHaveTextContent(
      'This item didn’t load.',
    );
    await expect(canvasElement.querySelector('[data-slot="inbox-item-pending"]')).not.toBeNull();
    await expect(canvasElement.querySelector('[data-slot="inbox-no-such-item"]')).not.toBeNull();
    // A ticket refused to a viewer without support's read: the read's own sentence.
    await expect(canvasElement.querySelector('[data-slot="inbox-item-refused"]')).toHaveTextContent(
      'Support tickets are read only by staff who answer them',
    );
  },
};
