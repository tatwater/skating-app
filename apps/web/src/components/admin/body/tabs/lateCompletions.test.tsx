import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ImageryTabView } from './imagery/ImageryTabView';
import { MASCOMA_PASSES, MASCOMA_SATELLITE, SEASON } from './imagery/imageryFixtures';
import { stubJsdomAnimations } from './jsdomStubs';
import { LinksTabView } from './links/LinksTabView';
import { BODY_NOW as LINKS_NOW, MASCOMA } from './links/linksFixtures';
import type { StaffLink } from './links/linksModel';
import { StandingTabView } from './standing/StandingTabView';
import { ACTIVE, ACTIVE_SINCE, BODY_NOW, MASCOMA_RETENTION } from './standing/standingFixtures';

beforeAll(stubJsdomAnimations);

/**
 * **A write's completion moves focus only if it may**: the attempt is the one that started it, its
 * editor is still the open one, and focus left with that editor (to the page, or the console's floor
 * around the tab) or was nowhere. It never takes focus from a control the moderator has since moved
 * to. Each case starts a write, holds it, moves on (where there is an editor, cancels it or leaves
 * it open; then focuses a control outside the tab), and lands it late.
 */

/** A control outside the tab the moderator moves to. */
function Elsewhere({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <input aria-label="Somewhere else" />
    </>
  );
}

const held = () => {
  const answers: (() => void)[] = [];
  const write = () => new Promise<boolean>((r) => answers.push(() => r(true)));
  return { answers, write, land: () => act(async () => answers.shift()?.()) };
};

/** A frame and a tick: long enough for a focus move deferred to the next frame to have happened. */
const settle = () =>
  act(async () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))));

/** A staff link's own Edit, found by the label its row shows. */
const editOf = (label: string) =>
  within(screen.getByText(label).closest<HTMLElement>('[data-link-key]') as HTMLElement).getByRole(
    'button',
    { name: 'Edit' },
  );

function LinksServer({ write }: { write: () => Promise<boolean> }) {
  const [links, setLinks] = useState<readonly StaffLink[]>(MASCOMA.referenceLinks ?? []);
  return (
    <LinksTabView
      body={{ ...MASCOMA, referenceLinks: links }}
      now={LINKS_NOW}
      canEdit
      lakeSheetHref={null}
      onSave={async (next) => {
        await write();
        setLinks(next);
      }}
    />
  );
}

type Case = {
  name: string;
  render: (write: () => Promise<boolean>) => ReactNode;
  /** Starts the write; `cancel` then leaves its editor (where it has one). */
  start: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  cancel?: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
};

const editLabel = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  const label = screen.getByRole('textbox', { name: 'Label' });
  await user.clear(label);
  await user.type(label, text);
};

const CASES: Case[] = [
  {
    name: 'Links: an edit',
    render: (write) => <LinksServer write={write} />,
    start: async (user) => {
      await user.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
      await editLabel(user, 'The Association');
      await user.click(screen.getByRole('button', { name: 'Done' }));
    },
    cancel: (user) => user.click(screen.getByRole('button', { name: 'Cancel' })),
  },
  {
    name: 'Links: an add',
    render: (write) => <LinksServer write={write} />,
    start: async (user) => {
      await user.click(screen.getByRole('button', { name: 'Add a link' }));
      await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Town page');
      await user.type(screen.getByRole('textbox', { name: 'Address' }), 'https://enfield.nh.gov');
      await user.click(screen.getByRole('button', { name: 'Done' }));
    },
    cancel: (user) => user.click(screen.getByRole('button', { name: 'Cancel' })),
  },
  {
    name: 'Links: a remove',
    render: (write) => <LinksServer write={write} />,
    start: async (user) => {
      await user.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
      await user.click(screen.getByRole('button', { name: 'Remove' }));
    },
    cancel: (user) => user.click(screen.getByRole('button', { name: 'Cancel' })),
  },
  {
    name: 'Links: a reorder',
    render: (write) => <LinksServer write={write} />,
    start: async (user) => {
      screen.getByRole('button', { name: 'Move Mascoma Lake Association' }).focus();
      await user.keyboard(' {ArrowDown} ');
    },
  },
  {
    name: 'Standing: set dormant',
    render: (write) => (
      <StandingTabView
        standing={ACTIVE}
        activeSince={ACTIVE_SINCE}
        retention={MASCOMA_RETENTION}
        now={BODY_NOW}
        canSetStanding
        canRemove
        onSetDormant={write}
        onSetActive={vi.fn(async () => true)}
        onRemove={vi.fn(async () => true)}
        onRestore={vi.fn(async () => true)}
      />
    ),
    start: async (user) => {
      await user.click(screen.getByRole('radio', { name: /^Dormant/ }));
      await user.type(
        screen.getByRole('textbox', { name: 'Note for skaters · optional' }),
        'x{Enter}',
      );
    },
  },
  {
    name: 'Imagery: the satellite link',
    render: (write) => (
      <ImageryTabView
        season={SEASON}
        rows={MASCOMA_PASSES}
        lit={null}
        onLitChange={() => {}}
        onOverride={async () => true}
        satellite={MASCOMA_SATELLITE}
        onSatelliteChange={write}
      />
    ),
    start: (user) => user.click(screen.getByRole('button', { name: 'Never' })),
  },
];

// Each case with an editor runs twice: canceled before the move, and left open — the save then
// closes its editor, and still takes no focus from where the moderator went.
const RUNS = CASES.flatMap((c) =>
  c.cancel === undefined
    ? [{ ...c, leftOpen: false }]
    : [
        { ...c, leftOpen: false },
        { ...c, name: `${c.name}, its editor left open`, cancel: undefined, leftOpen: true },
      ],
);

describe('a late completion never takes focus from where the moderator moved it', () => {
  it.each(RUNS)('$name', async (c) => {
    const user = userEvent.setup();
    const h = held();
    render(<Elsewhere>{c.render(h.write)}</Elsewhere>);
    await c.start(user);
    // The write really is out: a case whose start sent nothing would pass with nothing tested.
    expect(h.answers).toHaveLength(1);
    await c.cancel?.(user);
    // No hand moves on inside the frame its own keystroke asked for (a grip's step refocuses then).
    await settle();
    const elsewhere = screen.getByRole('textbox', { name: 'Somewhere else' });
    await user.click(elsewhere);
    await h.land();
    await settle();
    expect(elsewhere).toHaveFocus();
    // Left open, the editor was the one that sent: the save closed it all the same.
    if (c.leftOpen) expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('a completion whose editor is still open and focused keeps today’s behavior', () => {
  it('Links: an edit that lands hands focus to its own link’s Edit', async () => {
    const user = userEvent.setup();
    const h = held();
    render(<Elsewhere>{<LinksServer write={h.write} />}</Elsewhere>);
    // The second link, so its own Edit can't be confused with the section's first stop.
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
    await editLabel(user, 'Dam level');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await h.land();
    await settle();
    expect(editOf('Dam level')).toHaveFocus();
  });

  it('Links: focus the console’s floor holds (the panel around the tab) is taken back too', async () => {
    const user = userEvent.setup();
    const h = held();
    render(
      <div tabIndex={-1} data-slot="body-tab-panel">
        <LinksServer write={h.write} />
      </div>,
    );
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
    await editLabel(user, 'Dam level');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // `useKeepFocus` puts focus dropped to the page on the panel, and can get there before the
    // tab's own effect: the panel is not a place the moderator moved to.
    act(() => document.querySelector<HTMLElement>('[data-slot="body-tab-panel"]')?.focus());
    await h.land();
    await settle();
    expect(editOf('Dam level')).toHaveFocus();
  });
});
