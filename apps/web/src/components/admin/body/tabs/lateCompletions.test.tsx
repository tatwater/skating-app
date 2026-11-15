import { act, render, screen } from '@testing-library/react';
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
 * editor is still the open one, and focus is still inside that editor (or nowhere). It never takes
 * focus from a control the moderator has since moved to. Each case starts a write, holds it, moves
 * on (cancels where there is an editor, then focuses a control outside the tab), and lands it late.
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
  const write = () => new Promise<void>((r) => answers.push(r));
  return { answers, write, land: () => act(async () => answers.shift()?.()) };
};

function LinksServer({ write }: { write: () => Promise<void> }) {
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
  render: (write: () => Promise<void>) => ReactNode;
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
        onSetActive={vi.fn(async () => {})}
        onRemove={vi.fn(async () => {})}
        onRestore={vi.fn(async () => {})}
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
        onOverride={async () => {}}
        satellite={MASCOMA_SATELLITE}
        onSatelliteChange={write}
      />
    ),
    start: (user) => user.click(screen.getByRole('button', { name: 'Never' })),
  },
];

describe('a late completion never takes focus from where the moderator moved it', () => {
  it.each(CASES)('$name', async (c) => {
    const user = userEvent.setup();
    const h = held();
    render(<Elsewhere>{c.render(h.write)}</Elsewhere>);
    await c.start(user);
    await c.cancel?.(user);
    const elsewhere = screen.getByRole('textbox', { name: 'Somewhere else' });
    await user.click(elsewhere);
    await h.land();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(elsewhere).toHaveFocus();
  });
});

describe('a completion whose editor is still open and focused keeps today’s behavior', () => {
  it('Links: an edit that lands hands focus to its link’s Edit', async () => {
    const user = userEvent.setup();
    const h = held();
    render(<Elsewhere>{<LinksServer write={h.write} />}</Elsewhere>);
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0] as HTMLElement);
    await editLabel(user, 'The Association');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await h.land();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const edit = document.querySelector<HTMLElement>(
      '[data-link-key] [data-slot="link-edit"]',
    ) as HTMLElement;
    expect(edit).toHaveFocus();
  });
});
