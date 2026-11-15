import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fc from 'fast-check';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SortableRows } from '@/components/kit/sortable-rows';
import { LinksTabView, type LinksTabViewProps } from './LinksTabView';
import { BODY_NOW, MASCOMA, SMALL_POND } from './linksFixtures';
import type { StaffLink } from './linksModel';

const base: LinksTabViewProps = {
  body: MASCOMA,
  now: BODY_NOW,
  canEdit: true,
  onSave: vi.fn(async () => {}),
  lakeSheetHref: '/water/k1',
};

const status = () => document.querySelector('[data-slot="sortable-status"]')?.textContent;
const grip = (name: string) => screen.getByRole('button', { name: `Move ${name}` });
const rows = () =>
  [...document.querySelectorAll('[data-slot="sortable-row"]')].map(
    (r) => r.querySelector('.text-body')?.textContent,
  );

/** The view over a body whose links a save really changes, the way the console's read would. */
function Saving({ hold }: { hold?: Promise<void> }) {
  const [links, setLinks] = useState<readonly StaffLink[]>(MASCOMA.referenceLinks ?? []);
  return (
    <LinksTabView
      {...base}
      body={{ ...MASCOMA, referenceLinks: links }}
      onSave={async (next) => {
        await hold;
        setLinks(next);
      }}
    />
  );
}

/**
 * The view over a body whose saves land one at a time, when the test says: each save waits for
 * its own release and resolves; the links change (the echo) a beat later — the window where an
 * acknowledged write isn't on the page yet, and a list built from the page would be stale.
 */
function Held({ sent, releases }: { sent: StaffLink[][]; releases: (() => void)[] }) {
  const [links, setLinks] = useState<readonly StaffLink[]>(MASCOMA.referenceLinks ?? []);
  return (
    <LinksTabView
      {...base}
      body={{ ...MASCOMA, referenceLinks: links }}
      onSave={async (next) => {
        sent.push(next);
        await new Promise<void>((r) => releases.push(r));
        setTimeout(() => setLinks(next), 0);
      }}
    />
  );
}

/** Lets the held save land, then its echo. */
const land = async (releases: (() => void)[]) => {
  await act(async () => releases.shift()?.());
  await act(async () => new Promise((r) => setTimeout(r, 5)));
};

const ASSOC = { label: 'Mascoma Lake Association', url: 'https://mascomalake.org' };
const DAM = { label: 'Lake level at Mascoma Lake Dam', url: 'https://des.nh.gov/dams' };

describe('LinksTabView — saves queue: none is built from a list older than the last one saved', () => {
  /** Drops the first link below the second from the keyboard: a reorder save starts. */
  async function reorder(user: ReturnType<typeof userEvent.setup>) {
    grip(ASSOC.label).focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    grip(ASSOC.label).focus();
    await user.keyboard(' ');
  }

  it('an edit saved while a reorder is saving keeps the new order (Greptile’s P1)', async () => {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const releases: (() => void)[] = [];
    render(<Held sent={sent} releases={releases} />);
    await reorder(user);
    expect(sent).toEqual([[DAM, ASSOC]]);
    // The reorder hasn't landed: edit the dam's link and press ⏎.
    const editDam = within(
      screen.getByText(DAM.label).closest('[data-slot="sortable-row"]') as HTMLElement,
    ).getByRole('button', { name: 'Edit' });
    await user.click(editDam);
    const label = screen.getByRole('textbox', { name: /Label/ });
    await user.clear(label);
    await user.type(label, 'Dam level{Enter}');
    // Queued behind the reorder: nothing sent yet, and nothing built from the old order.
    expect(sent).toHaveLength(1);
    await land(releases);
    expect(sent[1]).toEqual([{ label: 'Dam level', url: DAM.url }, ASSOC]);
    await land(releases);
    expect(rows()).toEqual(['Dam level', ASSOC.label]);
  });

  it('a remove pressed while a reorder is saving removes from the new order', async () => {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const releases: (() => void)[] = [];
    render(<Held sent={sent} releases={releases} />);
    await reorder(user);
    const editAssoc = within(
      screen.getByText(ASSOC.label).closest('[data-slot="sortable-row"]') as HTMLElement,
    ).getByRole('button', { name: 'Edit' });
    await user.click(editAssoc);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await land(releases);
    expect(sent[1]).toEqual([DAM]);
    await land(releases);
    expect(rows()).toEqual([DAM.label]);
  });

  it('a queued save landing after Cancel never closes the editor opened since', async () => {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const releases: (() => void)[] = [];
    render(<Held sent={sent} releases={releases} />);
    await reorder(user);
    const editOf = (label: string) =>
      within(
        screen.getByText(label).closest('[data-slot="sortable-row"]') as HTMLElement,
      ).getByRole('button', { name: 'Edit' });
    await user.click(editOf(DAM.label));
    const label = screen.getByRole('textbox', { name: /Label/ });
    await user.clear(label);
    await user.type(label, 'Dam level{Enter}');
    // Queued behind the reorder; the moderator cancels and opens the other link.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(editOf(ASSOC.label));
    await user.type(screen.getByRole('textbox', { name: /Label/ }), ' (draft)');
    await land(releases);
    await land(releases);
    expect(sent[1]).toEqual([{ label: 'Dam level', url: DAM.url }, ASSOC]);
    // The other editor is still open, its draft kept.
    expect(screen.getByRole('textbox', { name: /Label/ })).toHaveValue(`${ASSOC.label} (draft)`);
  });

  it('a queued save landing after Cancel never closes the same link’s editor reopened since', async () => {
    // Greptile's P2 on #121: the old guard checked the link's key, so reopening the same link let
    // the first save close the new editor and discard what was typed since.
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const releases: (() => void)[] = [];
    render(<Held sent={sent} releases={releases} />);
    await reorder(user);
    const editDam = () =>
      within(
        screen
          .getByText(/Lake level at Mascoma Lake Dam|Dam level/)
          .closest('[data-slot="sortable-row"]') as HTMLElement,
      ).getByRole('button', { name: 'Edit' });
    await user.click(editDam());
    const label = screen.getByRole('textbox', { name: /Label/ });
    await user.clear(label);
    await user.type(label, 'Dam level{Enter}');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    // The same link, opened again, and a new draft started in it.
    await user.click(editDam());
    await user.type(screen.getByRole('textbox', { name: /Address/ }), '/levels');
    await land(releases);
    await land(releases);
    expect(sent[1]).toEqual([{ label: 'Dam level', url: DAM.url }, ASSOC]);
    // The reopened editor stands, its draft whole, and its own Done isn't held by the old save.
    expect(screen.getByRole('textbox', { name: /Address/ })).toHaveValue(`${DAM.url}/levels`);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(sent).toHaveLength(3);
  });

  it('a link added is editable once it shows, when the echo lands before the save resolves', async () => {
    // The console's own order: Convex shows the write before its promise resolves, and the
    // receipt (`announce`) is a further round trip — so the echo renders before the queue's ack.
    function EchoFirst({ sent }: { sent: StaffLink[][] }) {
      const [links, setLinks] = useState<readonly StaffLink[]>(MASCOMA.referenceLinks ?? []);
      return (
        <LinksTabView
          {...base}
          body={{ ...MASCOMA, referenceLinks: links }}
          onSave={async (next) => {
            sent.push(next);
            setLinks(next);
            await new Promise((r) => setTimeout(r, 0));
          }}
        />
      );
    }
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    render(<EchoFirst sent={sent} />);
    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.type(screen.getByRole('textbox', { name: /Label/ }), 'Town beach');
    await user.type(
      screen.getByRole('textbox', { name: /Address/ }),
      'https://enfield.nh.us{Enter}',
    );
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(rows()).toEqual([ASSOC.label, DAM.label, 'Town beach']);
    // The new link, edited: the edit is sent, never dropped as a change to a link the queue
    // doesn't know by that id.
    const editNew = within(
      screen.getByText('Town beach').closest('[data-slot="sortable-row"]') as HTMLElement,
    ).getByRole('button', { name: 'Edit' });
    await user.click(editNew);
    const label = screen.getByRole('textbox', { name: /Label/ });
    await user.clear(label);
    await user.type(label, 'Town beach lot{Enter}');
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(sent[1]).toEqual([
      ASSOC,
      DAM,
      { label: 'Town beach lot', url: 'https://enfield.nh.us' },
    ]);
    expect(rows()).toEqual([ASSOC.label, DAM.label, 'Town beach lot']);
  });

  it('a second ⏎ in the open editor never sends its save twice', async () => {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const releases: (() => void)[] = [];
    render(<Held sent={sent} releases={releases} />);
    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.type(screen.getByRole('textbox', { name: /Label/ }), 'Town beach');
    await user.type(
      screen.getByRole('textbox', { name: /Address/ }),
      'https://enfield.nh.us{Enter}{Enter}',
    );
    await land(releases);
    await land(releases);
    expect(sent).toEqual([[ASSOC, DAM, { label: 'Town beach', url: 'https://enfield.nh.us' }]]);
    expect(rows()).toEqual([ASSOC.label, DAM.label, 'Town beach']);
  });
});

describe('LinksTabView — over any run of opening, typing, Done, Cancel and reopening (fast-check)', () => {
  type Op =
    | { kind: 'edit'; row: number }
    | { kind: 'type'; text: string }
    | { kind: 'done' }
    | { kind: 'cancel' }
    | { kind: 'land' };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant('edit' as const), row: fc.nat(1) }),
    fc.record({ kind: fc.constant('type' as const), text: fc.constantFrom('x', 'yz') }),
    fc.record({ kind: fc.constant('done' as const) }),
    fc.record({ kind: fc.constant('cancel' as const) }),
    fc.record({ kind: fc.constant('land' as const) }),
  );

  it('a late save never closes or clears an editor it didn’t open, and every Done lands in order', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 10 }), async (ops) => {
        const user = userEvent.setup({ delay: null });
        const sent: StaffLink[][] = [];
        const releases: (() => void)[] = [];
        const { unmount } = render(<Held sent={sent} releases={releases} />);
        try {
          // What the open editor's label must read, or null with none open.
          let draft: string | null = null;
          let row = -1;
          // Each opening's id, and the openings whose saves are on their way, oldest first.
          let opening = 0;
          // The saves queued, in order; `noop` — a Done that changes nothing, waiting behind another
          // save: it sends nothing and answers the moment the save before it lands.
          const saves: { opening: number; text: string; noop?: boolean }[] = [];
          // Each row's label, as the Done presses left it, in order.
          const expected = [ASSOC.label, DAM.label];
          const editor = () => screen.queryByRole('textbox', { name: /Label/ });
          for (const o of ops) {
            if (o.kind === 'edit' && draft === null) {
              const edits = screen.queryAllByRole('button', { name: 'Edit' });
              const button = edits[o.row];
              if (button === undefined) continue;
              await user.click(button);
              opening++;
              row = o.row;
              draft = (editor() as HTMLInputElement).value;
            } else if (o.kind === 'type' && draft !== null) {
              await user.type(editor() as HTMLElement, o.text);
              draft += o.text;
            } else if (o.kind === 'done' && draft !== null) {
              const changes = draft !== expected[row] && !saves.some((v) => v.opening === opening);
              await user.click(screen.getByRole('button', { name: 'Done' }));
              // A Done that changes the link queues a save (it may wait behind another).
              if (changes) {
                expected[row] = draft;
                saves.push({ opening, text: draft });
              } else if (editor() !== null && !saves.some((v) => v.opening === opening)) {
                saves.push({ opening, text: draft, noop: true });
              }
              // A change waits open for its own save; one that changes nothing closes at once —
              // or, behind another save, the moment that one lands.
              if (editor() === null) draft = null;
            } else if (o.kind === 'cancel' && draft !== null) {
              await user.click(screen.getByRole('button', { name: 'Cancel' }));
              draft = null;
            } else if (o.kind === 'land' && releases.length > 0) {
              const from = saves.shift();
              await land(releases);
              // The no-op Dones queued right behind it answer with it.
              const answered = [from];
              while (saves[0]?.noop === true) answered.push(saves.shift());
              // Only the editor whose own save (or no-op Done) this was may close — and only if
              // its draft is still what it sent; any other stands, its draft whole.
              if (draft !== null) {
                if (answered.some((a) => a?.opening === opening && a.text === draft)) {
                  expect(editor()).toBeNull();
                  draft = null;
                } else {
                  expect((editor() as HTMLInputElement | null)?.value).toBe(draft);
                }
              }
            }
          }
          // Drain every save.
          for (let i = 0; i < 20 && releases.length > 0; i++) await land(releases);
          if (sent.length > 0) {
            expect((sent.at(-1) as StaffLink[]).map((l) => l.label)).toEqual(expected);
          }
        } finally {
          unmount();
        }
      }),
      {
        numRuns: 45,
        // The review's sequence, seeded so every run covers it: a save on its way, Cancel, the
        // same link and the other reopened, a draft typed, then the old save lands. And a Done that
        // changes nothing, queued behind another link's save, answering when that one lands.
        examples: [
          [
            [
              { kind: 'edit', row: 0 },
              { kind: 'type', text: 'x' },
              { kind: 'done' },
              { kind: 'cancel' },
              { kind: 'edit', row: 1 },
              { kind: 'done' },
              { kind: 'land' },
            ],
          ],
          [
            [
              { kind: 'edit', row: 1 },
              { kind: 'type', text: 'x' },
              { kind: 'done' },
              { kind: 'cancel' },
              { kind: 'edit', row: 1 },
              { kind: 'type', text: 'yz' },
              { kind: 'land' },
              { kind: 'done' },
              { kind: 'land' },
            ],
          ],
          [
            [
              { kind: 'edit', row: 0 },
              { kind: 'type', text: 'x' },
              { kind: 'done' },
              { kind: 'cancel' },
              { kind: 'edit', row: 1 },
              { kind: 'type', text: 'x' },
              { kind: 'land' },
            ],
          ],
        ],
      },
    );
  });
});

describe('LinksTabView — a save never loses a link or the keyboard', () => {
  it('a link edited while another is lifted is still there once saved (the review’s case)', async () => {
    const user = userEvent.setup();
    render(<Saving />);
    // Lift the first link with Space, then edit the second and save it.
    grip('Mascoma Lake Association').focus();
    await user.keyboard(' ');
    const second = screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement;
    await user.click(second);
    const label = screen.getByRole('textbox', { name: /Label/ });
    await user.clear(label);
    await user.type(label, 'Dam level');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(rows()).toEqual(['Mascoma Lake Association', 'Dam level']);
  });

  it('a drop from the keyboard keeps focus on its grip through the save and after it', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    render(<Saving hold={hold} />);
    grip('Lake level at Mascoma Lake Dam').focus();
    await user.keyboard(' {ArrowUp} ');
    // Saving: the grip stays, focusable and inert, where it was dropped.
    const g = grip('Lake level at Mascoma Lake Dam');
    expect(g).toHaveAttribute('aria-disabled', 'true');
    expect(g).toHaveFocus();
    expect(rows()).toEqual(['Lake level at Mascoma Lake Dam', 'Mascoma Lake Association']);
    await act(async () => {
      release();
      await hold;
    });
    expect(grip('Lake level at Mascoma Lake Dam')).toHaveFocus();
    expect(grip('Lake level at Mascoma Lake Dam')).not.toHaveAttribute('aria-disabled');
  });

  it('after an edit is saved, focus is on that link’s Edit again — never the page', async () => {
    const user = userEvent.setup();
    render(<Saving />);
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    const label = screen.getByRole('textbox', { name: /Label/ });
    await user.clear(label);
    await user.type(label, 'The association{Enter}');
    const row = screen
      .getByText('The association')
      .closest('[data-slot="link-row"]') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Edit' })).toHaveFocus();
  });

  it('after a link is removed, focus stays in the section', async () => {
    const user = userEvent.setup();
    render(<Saving />);
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: /Remove/ }));
    const added = screen.getByRole('region', { name: 'Added by staff' });
    expect(added.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('LinksTabView', () => {
  it('draws the board: three built from the lake, two added by staff, each opening a new tab', () => {
    render(<LinksTabView {...base} />);
    const built = screen.getByRole('region', { name: 'Built from the lake' });
    expect(within(built).getByText('3')).toBeVisible();
    const added = screen.getByRole('region', { name: 'Added by staff' });
    expect(within(added).getByText('2')).toBeVisible();
    expect(rows()).toEqual(['Mascoma Lake Association', 'Lake level at Mascoma Lake Dam']);
    const open = screen.getByRole('link', { name: /Mascoma Lake Association/ });
    expect(open).toHaveAttribute('href', 'https://mascomalake.org');
    expect(open).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Skaters read all 5, in this order, under Elsewhere.')).toBeVisible();
    expect(screen.getByRole('link', { name: /Lake sheet/ })).toHaveAttribute('href', '/water/k1');
  });

  it('a withheld Copernicus link rests faded, its button off', () => {
    render(<LinksTabView {...base} body={SMALL_POND} />);
    const row = screen
      .getByText('Recent satellite passes on Copernicus Browser')
      .closest('[data-slot="link-row"]');
    expect(row).not.toHaveAttribute('data-offered');
    expect(within(row as HTMLElement).getByRole('button')).toBeDisabled();
    expect(screen.getByText('Skaters read all 2, in this order, under Elsewhere.')).toBeVisible();
  });

  it('with no link at all, says the sheet has no Elsewhere — never “all 0”', () => {
    // No point to open Windy on, no community for its state, no staff links.
    render(<LinksTabView {...base} body={{ name: 'Nameless Pond', states: [] }} />);
    expect(
      screen.getByText('With no links, the lake sheet has no Elsewhere section.'),
    ).toBeVisible();
    expect(screen.queryByText(/all 0/)).toBeNull();
  });

  it('draws no grip, Edit or Add for a viewer without the capability', () => {
    render(<LinksTabView {...base} canEdit={false} />);
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a link' })).toBeNull();
  });

  it('edits a row in place and saves the whole list', async () => {
    const onSave = vi.fn(async () => {});
    render(<LinksTabView {...base} onSave={onSave} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    const label = screen.getByRole('textbox', { name: 'Label' });
    await userEvent.clear(label);
    await userEvent.type(label, 'The Association{Enter}');
    expect(onSave).toHaveBeenCalledWith([
      { label: 'The Association', url: 'https://mascomalake.org' },
      { label: 'Lake level at Mascoma Lake Dam', url: 'https://des.nh.gov/dams' },
    ]);
  });

  it('refuses a bad address before the round trip, in core’s words', async () => {
    const onSave = vi.fn(async () => {});
    render(<LinksTabView {...base} onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a link' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), 'Town page');
    await userEvent.type(screen.getByRole('textbox', { name: 'Address' }), 'javascript:alert(1)');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('alert')).toHaveTextContent('A link must be http:// or https://.');
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Address' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Address' }),
      ' https://enfield.nh.gov ',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenLastCalledWith([
      ...(MASCOMA.referenceLinks ?? []),
      { label: 'Town page', url: 'https://enfield.nh.gov' },
    ]);
  });

  it('Remove is inside the row; Esc and Cancel put it back unchanged', async () => {
    const onSave = vi.fn(async () => {});
    render(<LinksTabView {...base} onSave={onSave} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onSave).toHaveBeenCalledWith([MASCOMA.referenceLinks?.[0]]);
  });

  it('a new row has no Remove; canceling it drops it', async () => {
    render(<LinksTabView {...base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a link' }));
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a refused save says why', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('A body carries at most 8 reference links');
    });
    render(<LinksTabView {...base} onSave={onSave} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    // A change to send (Done on an unchanged link sends nothing).
    await userEvent.type(screen.getByPlaceholderText('What the link is, as skaters read it'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 8');
  });

  it('reorders from the keyboard and writes the new order once, on the drop', async () => {
    const onSave = vi.fn(async () => {});
    render(<LinksTabView {...base} onSave={onSave} />);
    grip('Mascoma Lake Association').focus();
    await userEvent.keyboard(' ');
    expect(status()).toMatch(/^Lifted Mascoma Lake Association, 1 of 2\./);
    await userEvent.keyboard('{ArrowDown}');
    expect(status()).toBe('Moved Mascoma Lake Association to 2 of 2.');
    expect(rows()).toEqual(['Lake level at Mascoma Lake Dam', 'Mascoma Lake Association']);
    expect(onSave).not.toHaveBeenCalled();
    grip('Mascoma Lake Association').focus();
    await userEvent.keyboard(' ');
    expect(status()).toBe('Dropped Mascoma Lake Association at 2 of 2.');
    expect(onSave).toHaveBeenCalledWith([
      { label: 'Lake level at Mascoma Lake Dam', url: 'https://des.nh.gov/dams' },
      { label: 'Mascoma Lake Association', url: 'https://mascomalake.org' },
    ]);
  });
});

describe('SortableRows', () => {
  const ITEMS = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Bravo' },
    { id: 'c', name: 'Charlie' },
  ];
  const setup = (onReorder = vi.fn()) => {
    render(
      <SortableRows
        aria-label="Things"
        items={ITEMS}
        idOf={(i) => i.id}
        labelOf={(i) => i.name}
        onReorder={onReorder}
        renderRow={(item, { grip, lifted }) => (
          <div data-lifted-row={lifted ? '' : undefined}>
            {grip}
            <span className="text-body">{item.name}</span>
          </div>
        )}
      />,
    );
    return onReorder;
  };

  it('Esc puts a lifted row back and writes nothing', async () => {
    const onReorder = setup();
    grip('Alpha').focus();
    await userEvent.keyboard(' {ArrowDown}{ArrowDown}');
    expect(rows()).toEqual(['Bravo', 'Charlie', 'Alpha']);
    grip('Alpha').focus();
    await userEvent.keyboard('{Escape}');
    expect(rows()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(status()).toBe('Canceled. Alpha is back at 1 of 3.');
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('a lifted row can’t move past either end, and a drop where it started writes nothing', async () => {
    const onReorder = setup();
    grip('Alpha').focus();
    await userEvent.keyboard(' {ArrowUp}');
    // Nothing moved, so nothing is said to have.
    expect(status()).toMatch(/^Lifted Alpha, 1 of 3\./);
    await userEvent.keyboard(' ');
    expect(onReorder).not.toHaveBeenCalled();
    expect(status()).toBe('Dropped Alpha at 1 of 3.');
  });

  it('⌥↓ moves a row one place in one stroke; a bare arrow does nothing at rest', async () => {
    const onReorder = setup();
    grip('Bravo').focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onReorder).not.toHaveBeenCalled();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('drags by the grip: the row follows the pointer and lands on release', () => {
    const onReorder = setup();
    // jsdom lays nothing out: give each row a 20 px box, top to bottom.
    document.querySelectorAll<HTMLElement>('[data-slot="sortable-row"]').forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: i * 20, height: 20 }) as DOMRect;
    });
    const handle = grip('Alpha');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 10 });
    expect(handle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 55 });
    expect(rows()).toEqual(['Bravo', 'Charlie', 'Alpha']);
    // Another pointer is ignored.
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 55 });
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('a canceled pointer puts the row back', () => {
    const onReorder = setup();
    document.querySelectorAll<HTMLElement>('[data-slot="sortable-row"]').forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: i * 20, height: 20 }) as DOMRect;
    });
    const handle = grip('Charlie');
    fireEvent.pointerDown(handle, { button: 2, pointerId: 1 });
    expect(handle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 50 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 });
    expect(rows()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    act(() => {
      fireEvent.pointerCancel(handle, { pointerId: 1 });
    });
    expect(rows()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('LinksTabView — a finished save never discards what was typed since it was sent', () => {
  /** A held save that the test lands or refuses. */
  function Answerable({
    sent,
    answers,
  }: {
    sent: StaffLink[][];
    answers: ((refusal?: Error) => void)[];
  }) {
    const [links, setLinks] = useState<readonly StaffLink[]>(MASCOMA.referenceLinks ?? []);
    return (
      <LinksTabView
        {...base}
        body={{ ...MASCOMA, referenceLinks: links }}
        onSave={async (next) => {
          sent.push(next);
          await new Promise<void>((resolve, reject) =>
            answers.push((refusal) => (refusal === undefined ? resolve() : reject(refusal))),
          );
          setTimeout(() => setLinks(next), 0);
        }}
      />
    );
  }
  const answer = async (answers: ((refusal?: Error) => void)[], refusal?: Error) => {
    await act(async () => answers.shift()?.(refusal));
    await act(async () => new Promise((r) => setTimeout(r, 5)));
  };
  const label = () => screen.getByRole('textbox', { name: 'Label' }) as HTMLInputElement;

  it('an edit: typed on before the answer, the editor stays open with the newer text, and saves again', async () => {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const answers: ((refusal?: Error) => void)[] = [];
    render(<Answerable sent={sent} answers={answers} />);
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    await user.clear(label());
    await user.type(label(), 'The Association');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // Typing on while the save is out.
    await user.type(label(), ' of Mascoma');
    await answer(answers);
    expect(sent).toEqual([[{ ...ASSOC, label: 'The Association' }, DAM]]);
    // Still open, the newer text whole — an unsaved edit over the saved value.
    expect(label().value).toBe('The Association of Mascoma');
    expect(screen.getByRole('button', { name: 'Done' })).not.toHaveAttribute('aria-busy', 'true');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(sent.at(-1)).toEqual([{ ...ASSOC, label: 'The Association of Mascoma' }, DAM]);
    await answer(answers);
    expect(screen.queryByRole('textbox', { name: 'Label' })).toBeNull();
  });

  it('a refused edit: the editor stays open with the newer text, and saves again', async () => {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const answers: ((refusal?: Error) => void)[] = [];
    render(<Answerable sent={sent} answers={answers} />);
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    await user.clear(label());
    await user.type(label(), 'The Association');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.type(label(), ' of Mascoma');
    await answer(answers, new Error('Not allowed'));
    expect(label().value).toBe('The Association of Mascoma');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(sent.at(-1)).toEqual([{ ...ASSOC, label: 'The Association of Mascoma' }, DAM]);
  });

  it('an add: typed on before the answer, the next Done edits the link it added — never a second one', async () => {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const answers: ((refusal?: Error) => void)[] = [];
    render(<Answerable sent={sent} answers={answers} />);
    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.type(label(), 'Town page');
    await user.type(screen.getByRole('textbox', { name: 'Address' }), 'https://enfield.nh.gov');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.type(label(), 's');
    await answer(answers);
    expect(label().value).toBe('Town pages');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(sent.at(-1)).toEqual([
      ASSOC,
      DAM,
      { label: 'Town pages', url: 'https://enfield.nh.gov' },
    ]);
    await answer(answers);
    expect(screen.queryByRole('textbox', { name: 'Label' })).toBeNull();
    expect(screen.getAllByText(/^Town page/)).toHaveLength(1);
  });

  it('an add: typed on in the address as the save lands, the keys go on into the address, never the Label', async () => {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const answers: ((refusal?: Error) => void)[] = [];
    render(<Answerable sent={sent} answers={answers} />);
    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.type(label(), 'Town page');
    const address = () => screen.getByRole('textbox', { name: 'Address' });
    await user.type(address(), 'https://enfield.nh.gov');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // Back in the address, typing on, as the save lands and the editor takes the added row.
    await user.type(address(), '/beach');
    await answer(answers);
    expect(address()).toHaveFocus();
    await user.keyboard('es');
    expect(address()).toHaveValue('https://enfield.nh.gov/beaches');
    expect(label()).toHaveValue('Town page');
  });
});

describe('LinksTabView — an added link’s editor is bound to the link it added, by identity', () => {
  /** A held save; its echo shows `before` or `after` the save's answer, when the test says. */
  function Echoing({
    sent,
    answers,
    echo,
  }: {
    sent: StaffLink[][];
    answers: (() => void)[];
    echo: 'before' | 'after';
  }) {
    const [links, setLinks] = useState<readonly StaffLink[]>(MASCOMA.referenceLinks ?? []);
    return (
      <LinksTabView
        {...base}
        body={{ ...MASCOMA, referenceLinks: links }}
        onSave={async (next) => {
          sent.push(next);
          if (echo === 'before') setLinks(next);
          await new Promise<void>((r) => answers.push(r));
          if (echo === 'after') setTimeout(() => setLinks(next), 0);
        }}
      />
    );
  }
  const answer = async (answers: (() => void)[]) => {
    await act(async () => answers.shift()?.());
    await act(async () => new Promise((r) => setTimeout(r, 5)));
  };
  const field = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;

  it.each(['before', 'after'] as const)(
    'a duplicate of an existing link, typed on while saving (echo %s the answer): the next Done edits the new one',
    async (echo) => {
      const user = userEvent.setup();
      const sent: StaffLink[][] = [];
      const answers: (() => void)[] = [];
      render(<Echoing sent={sent} answers={answers} echo={echo} />);
      await user.click(screen.getByRole('button', { name: 'Add a link' }));
      await user.type(field('Label'), ASSOC.label);
      await user.type(field('Address'), ASSOC.url);
      await user.click(screen.getByRole('button', { name: 'Done' }));
      await user.type(field('Label'), ' (lake)');
      await answer(answers);
      expect(field('Label').value).toBe(`${ASSOC.label} (lake)`);
      await user.click(screen.getByRole('button', { name: 'Done' }));
      // The older duplicate is untouched; the one this editor added carries the newer words.
      expect(sent.at(-1)).toEqual([ASSOC, DAM, { label: `${ASSOC.label} (lake)`, url: ASSOC.url }]);
    },
  );

  it.each(['before', 'after'] as const)(
    'the caret, the selection and focus are untouched when the add lands (echo %s the answer)',
    async (echo) => {
      const user = userEvent.setup();
      const sent: StaffLink[][] = [];
      const answers: (() => void)[] = [];
      render(<Echoing sent={sent} answers={answers} echo={echo} />);
      await user.click(screen.getByRole('button', { name: 'Add a link' }));
      await user.type(field('Label'), 'Town page');
      await user.type(field('Address'), 'https://enfield.nh.gov');
      await user.click(screen.getByRole('button', { name: 'Done' }));
      const url = field('Address');
      url.focus();
      url.setSelectionRange(8, 8);
      await user.keyboard('x');
      const before = { el: url, start: url.selectionStart, end: url.selectionEnd };
      await answer(answers);
      const after = field('Address');
      expect(after).toBe(before.el);
      expect(document.activeElement).toBe(before.el);
      expect([after.selectionStart, after.selectionEnd]).toEqual([before.start, before.end]);
      await user.keyboard('y');
      expect(after.value).toBe('https://xyenfield.nh.gov');
    },
  );

  /**
   * Saves answered and shown apart, each when the test says: the queue's acknowledgment can land a
   * beat before the render that shows its write (`listWriter`), and another moderator's write can
   * fold into what the server shows.
   */
  function Lagging({
    sent,
    answers,
    show,
  }: {
    sent: StaffLink[][];
    answers: ((refusal?: Error) => void)[];
    show: { current: (links: StaffLink[]) => void };
  }) {
    const [links, setLinks] = useState<readonly StaffLink[]>(MASCOMA.referenceLinks ?? []);
    show.current = setLinks;
    return (
      <LinksTabView
        {...base}
        body={{ ...MASCOMA, referenceLinks: links }}
        onSave={async (next) => {
          sent.push(next);
          await new Promise<void>((resolve, reject) =>
            answers.push((refusal) => (refusal === undefined ? resolve() : reject(refusal))),
          );
        }}
      />
    );
  }
  const LOST = /can’t tell which row/;
  const town = (label: string) => ({ label, url: 'https://enfield.nh.gov' });
  /** An add typed on while it saves, then acknowledged — not yet shown. */
  async function addedAndAcked() {
    const user = userEvent.setup();
    const sent: StaffLink[][] = [];
    const answers: ((refusal?: Error) => void)[] = [];
    const show = { current: (_: StaffLink[]) => {} };
    render(<Lagging sent={sent} answers={answers} show={show} />);
    await user.click(screen.getByRole('button', { name: 'Add a link' }));
    await user.type(field('Label'), 'Town page');
    await user.type(field('Address'), 'https://enfield.nh.gov');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.type(field('Label'), 's');
    await act(async () => answers.shift()?.());
    return { user, sent, answers, show };
  }

  it('a saved add edited before its echo shows: Done edits it, and the late echo draws it once', async () => {
    const { user, sent, answers, show } = await addedAndAcked();
    // Acknowledged, not on the page yet: the queue holds the add, so Done edits it.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(LOST)).toBeNull();
    expect(sent).toEqual([
      [ASSOC, DAM, town('Town page')],
      [ASSOC, DAM, town('Town pages')],
    ]);
    // The add's echo shows while the edit is out: its row is the open editor's, drawn once.
    await act(async () => show.current(sent[0] as StaffLink[]));
    expect(rows()).toEqual([ASSOC.label, DAM.label]);
    // The edit refused: the next Done still edits the link it added.
    await act(async () => answers.shift()?.(new Error('Not now')));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(LOST)).toBeNull();
    expect(sent).toHaveLength(3);
    expect(sent.at(-1)).toEqual([ASSOC, DAM, town('Town pages')]);
  });

  it('a saved add the list has lost: Remove says so and sends nothing — never closes as if removed', async () => {
    const { user, sent, show } = await addedAndAcked();
    // Shown with another moderator's reorder folded in: no list this page sent.
    await act(async () => show.current([DAM, ASSOC, town('Town page')]));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(LOST)).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(field('Label')).toHaveValue('Town pages');
  });

  it('a list that only reads like one this page sent long ago takes no keys from it', async () => {
    // The page's edit is shown, then others undo it, add the same words back as a new link and
    // remove the link between: the list reads like the edit again, but the open editor's link is
    // the new one, and it keeps its row.
    const user = userEvent.setup();
    const view = (links: StaffLink[]) => (
      <LinksTabView
        {...base}
        body={{ ...MASCOMA, referenceLinks: links }}
        onSave={async () => {}}
      />
    );
    const { rerender } = render(view([ASSOC, DAM]));
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
    await user.clear(field('Label'));
    await user.type(field('Label'), 'Town page');
    await user.clear(field('Address'));
    await user.type(field('Address'), 'https://enfield.nh.gov{Enter}');
    rerender(view([ASSOC, town('Town page')]));
    rerender(view([ASSOC, DAM]));
    rerender(view([ASSOC, DAM, town('Town page')]));
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[2] as HTMLElement);
    await user.type(field('Label'), ' (beach)');
    rerender(view([ASSOC, town('Town page')]));
    expect(field('Label')).toHaveValue('Town page (beach)');
  });
});

describe('LinksTabView — over any run of adds (duplicates allowed), edits, removes, reorders, late answers and refusals (fast-check)', () => {
  type Op =
    | { kind: 'add'; dup: number | null }
    | { kind: 'edit'; row: number }
    | { kind: 'type'; text: string }
    | { kind: 'done' }
    | { kind: 'cancel' }
    | { kind: 'remove' }
    | { kind: 'reorder' }
    | { kind: 'answer'; ok: boolean };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant('add' as const), dup: fc.option(fc.nat(3), { nil: null }) }),
    fc.record({ kind: fc.constant('edit' as const), row: fc.nat(3) }),
    fc.record({ kind: fc.constant('type' as const), text: fc.constantFrom('a', 'b') }),
    fc.constant({ kind: 'done' as const }),
    fc.constant({ kind: 'cancel' as const }),
    fc.constant({ kind: 'remove' as const }),
    fc.constant({ kind: 'reorder' as const }),
    fc.record({ kind: fc.constant('answer' as const), ok: fc.boolean() }),
  );

  function Server({ sent, answers }: { sent: StaffLink[][]; answers: ((ok: boolean) => void)[] }) {
    const [links, setLinks] = useState<readonly StaffLink[]>(MASCOMA.referenceLinks ?? []);
    return (
      <LinksTabView
        {...base}
        body={{ ...MASCOMA, referenceLinks: links }}
        onSave={async (next) => {
          sent.push(next);
          const ok = await new Promise<boolean>((r) => answers.push(r));
          if (!ok) throw new Error('refused');
          setTimeout(() => setLinks(next), 0);
        }}
      />
    );
  }

  it('an editor is never bound to another link than the one it was opened for or added', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 12 }), async (ops) => {
        const user = userEvent.setup({ delay: null });
        const sent: StaffLink[][] = [];
        const answers: ((ok: boolean) => void)[] = [];
        const { unmount } = render(<Server sent={sent} answers={answers} />);
        try {
          const editor = () => document.querySelector<HTMLElement>('[data-slot="link-editor"]');
          const rowsNow = () =>
            [...document.querySelectorAll<HTMLElement>('[data-link-key]')].map(
              (r) => r.dataset.linkKey,
            );
          // The identity the open editor was opened with.
          let bound: string | null = null;
          for (const o of ops) {
            const ed = editor();
            if (ed === null) bound = null;
            if (o.kind === 'add' && ed === null) {
              const add = screen.queryByRole('button', { name: 'Add a link' });
              if (add === null) continue;
              await user.click(add);
              bound = editor()?.dataset.editingKey ?? null;
              const rows = screen.queryAllByText(/^(Mascoma|Lake level)/);
              const dup = o.dup === null ? null : rows[o.dup % Math.max(1, rows.length)];
              const label = dup?.textContent ?? 'Town page';
              await user.type(screen.getByRole('textbox', { name: 'Label' }), label);
              await user.type(
                screen.getByRole('textbox', { name: 'Address' }),
                label.startsWith('Mascoma')
                  ? ASSOC.url
                  : label.startsWith('Lake')
                    ? DAM.url
                    : 'https://t.example',
              );
            } else if (o.kind === 'edit' && ed === null) {
              const keys = rowsNow();
              const key = keys[o.row % Math.max(1, keys.length)];
              const button =
                key === undefined
                  ? null
                  : document.querySelector<HTMLElement>(
                      `[data-link-key="${key}"] [data-slot="link-edit"]`,
                    );
              if (button === null) continue;
              await user.click(button);
              bound = key ?? null;
            } else if (o.kind === 'type' && ed !== null) {
              await user.type(screen.getByRole('textbox', { name: 'Label' }), o.text);
            } else if (o.kind === 'done' && ed !== null) {
              await user.click(screen.getByRole('button', { name: 'Done' }));
            } else if (o.kind === 'cancel' && ed !== null) {
              await user.click(screen.getByRole('button', { name: 'Cancel' }));
            } else if (o.kind === 'remove' && ed !== null) {
              const remove = screen.queryByRole('button', { name: 'Remove' });
              if (remove !== null) await user.click(remove);
            } else if (o.kind === 'reorder' && ed === null) {
              const g = document.querySelector<HTMLElement>('[data-slot="sortable-grip"]');
              if (g === null || g.getAttribute('aria-disabled') === 'true') continue;
              g.focus();
              await user.keyboard(' {ArrowDown} ');
            } else if (o.kind === 'answer') {
              await act(async () => answers.shift()?.(o.ok));
              await act(async () => new Promise((r) => setTimeout(r, 2)));
            }
            const now = editor();
            // The open editor is still bound to what it was opened with or added.
            if (now !== null && bound !== null) expect(now.dataset.editingKey).toBe(bound);
            // Its link is drawn once — as the editor, never also as a row beside it.
            if (now !== null) expect(rowsNow()).not.toContain(now.dataset.editingKey);
            // This page is the server's only writer: an added link is never lost to it.
            expect(screen.queryByText(/can’t tell which row/)).toBeNull();
          }
        } finally {
          for (let i = 0; i < 30 && answers.length > 0; i++) {
            await act(async () => answers.shift()?.(true));
            await act(async () => new Promise((r) => setTimeout(r, 2)));
          }
          unmount();
        }
      }),
      {
        numRuns: 30,
        // The review's case: a duplicate of an existing link added, typed on before the answer.
        examples: [
          [
            [
              { kind: 'add', dup: 0 },
              { kind: 'done' },
              { kind: 'type', text: 'a' },
              { kind: 'answer', ok: true },
              { kind: 'done' },
              { kind: 'answer', ok: true },
            ],
          ],
        ],
      },
    );
  });
});
