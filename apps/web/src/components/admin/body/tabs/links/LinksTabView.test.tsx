import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
