import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReadFailure } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { ShapeTabView } from '../tabs/shape/ShapeTab';
import { BodyConsoleMissing, BodyConsoleView } from './BodyConsoleView';
import { boostToSend } from './BodyLeftColumn';
import {
  BODY_NOW,
  CAPPED_HISTORY,
  MASCOMA_ASKS,
  MASCOMA_COMPLETENESS,
  MASCOMA_HISTORY_ENTRIES,
  MASCOMA_IDENTITY,
  MASCOMA_TOWNS,
  MASCOMA_TRUST,
} from './bodyFixtures';
import { attentionTabs } from './bodyModel';
import { NotBuiltTab } from './NotBuiltTab';
import { useTabKeys } from './tabKeys';

beforeAll(stubJsdomAnimations);

function Page(props: Partial<Parameters<typeof BodyConsoleView>[0]> & { panel?: ReactNode }) {
  const { panel, ...rest } = props;
  return (
    <KeysProvider>
      <BodyConsoleView
        identity={MASCOMA_IDENTITY}
        completeness={MASCOMA_COMPLETENESS}
        towns={MASCOMA_TOWNS}
        trust={MASCOMA_TRUST}
        asks={MASCOMA_ASKS}
        history={MASCOMA_HISTORY_ENTRIES}
        lit={null}
        now={BODY_NOW}
        tab="shape"
        onTabChange={() => {}}
        onOpenAsk={() => {}}
        attention={attentionTabs(MASCOMA_COMPLETENESS.missing)}
        tabPanel={panel ?? <p>Shape</p>}
        map={<div>map</div>}
        {...rest}
      />
    </KeysProvider>
  );
}

/** A tab with one key, C, as every tab binds its keys. */
function KeyedTab({ onKey }: { onKey: () => void }) {
  const own = useRef<HTMLDivElement | null>(null);
  useTabKeys(own, [{ key: 'C', label: 'Chord', run: onKey }]);
  return (
    <div ref={own}>
      <button type="button">In the tab</button>
    </div>
  );
}

/** Each way a tab is reached, and where focus is left by it. */
const ARRIVALS: [string, (user: ReturnType<typeof userEvent.setup>) => Promise<void>][] = [
  // The list's Open and a deep link both mount the console with nothing focused.
  ['the list’s Open or a deep link', async () => {}],
  ['a press on the tab strip', (user) => user.click(screen.getByRole('tab', { name: /Names/ }))],
  [
    'the tab strip’s arrows and ⏎ (the arrows alone only move focus along the strip)',
    async (user) => {
      screen.getByRole('tab', { name: /Shape/ }).focus();
      await user.keyboard('{ArrowRight}{Enter}');
      expect(screen.getByRole('tab', { name: /Names/ })).toHaveFocus();
    },
  ],
  [
    'an ask',
    async (user) => {
      screen.getByRole('listbox', { name: 'Asked of this body' }).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveFocus());
    },
  ],
  [
    'focus already in the tab',
    async () => screen.getByRole('button', { name: 'In the tab' }).focus(),
  ],
];

describe('a tab’s keys, however the tab is reached', () => {
  it.each(ARRIVALS)('work after %s', async (_name, arrive) => {
    const user = userEvent.setup();
    const onKey = vi.fn();
    render(<Page bodyKey="k1" panel={<KeyedTab onKey={onKey} />} />);
    await arrive(user);
    await user.keyboard('c');
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('Shape’s ways answer their keys right after an ask hands focus over', async () => {
    const user = userEvent.setup();
    const onAddBay = vi.fn();
    render(
      <Page
        bodyKey="k1"
        panel={
          <ShapeTabView
            outline={undefined}
            bays={[]}
            lit={null}
            onLitChange={() => {}}
            onAddBay={onAddBay}
          />
        }
      />,
    );
    screen.getByRole('listbox', { name: 'Asked of this body' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveFocus());
    await user.keyboard('c');
    expect(onAddBay).toHaveBeenCalledWith('chord');
  });

  it('arriving with nothing focused puts focus in the panel; arriving with focus leaves it', () => {
    const { rerender } = render(<Page bodyKey="k1" />);
    expect(screen.getByRole('tabpanel')).toHaveFocus();
    const strip = screen.getByRole('tab', { name: /Names/ });
    strip.focus();
    rerender(<Page bodyKey="k2" />);
    expect(strip).toHaveFocus();
  });

  it('a tab change or a new body opens the panel at its top, never at the last tab’s scroll', () => {
    const { rerender } = render(<Page bodyKey="k1" tab="shape" />);
    const panel = screen.getByRole('tabpanel');
    panel.scrollTop = 400;
    rerender(<Page bodyKey="k1" tab="names" />);
    expect(screen.getByRole('tabpanel').scrollTop).toBe(0);
    screen.getByRole('tabpanel').scrollTop = 400;
    rerender(<Page bodyKey="k2" tab="names" />);
    expect(screen.getByRole('tabpanel').scrollTop).toBe(0);
  });
});

describe('BodyConsoleView', () => {
  it('answers the keyboard wherever it answers a click: the asks, the history, the boost, the tabs', () => {
    const { container } = render(<Page onReturn={() => {}} onBoostCommit={() => {}} />);
    expect(expectKeyboardOperable(container).length).toBeGreaterThan(0);
  });

  it('opens an ask from the keyboard and moves focus into the inspector', async () => {
    const user = userEvent.setup();
    const onOpenAsk = vi.fn();
    render(<Page onOpenAsk={onOpenAsk} />);
    const list = screen.getByRole('listbox', { name: 'Asked of this body' });
    list.focus();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onOpenAsk).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'placeName:placename1', tab: 'places' }),
    );
    await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveFocus());
  });

  it('type-ahead moves the cursor without opening anything', async () => {
    const user = userEvent.setup();
    const onOpenAsk = vi.fn();
    render(<Page onOpenAsk={onOpenAsk} />);
    const list = screen.getByRole('listbox', { name: 'Asked of this body' });
    list.focus();
    await user.keyboard('t');
    expect(onOpenAsk).not.toHaveBeenCalled();
    expect(list.getAttribute('aria-activedescendant')).toBe(
      within(list).getByRole('option', { name: /the Narrows/ }).id,
    );
    await user.keyboard('{End}{Home} ');
    expect(onOpenAsk).toHaveBeenCalledWith(expect.objectContaining({ id: 'ask:bayask1' }));
  });

  it('goes back to the list on ⇧⏎ — never opening the ask under the cursor', async () => {
    const user = userEvent.setup();
    const onReturn = vi.fn();
    const onOpenAsk = vi.fn();
    render(<Page onReturn={onReturn} onOpenAsk={onOpenAsk} />);
    screen.getByRole('listbox', { name: 'Asked of this body' }).focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onOpenAsk).not.toHaveBeenCalled();
  });

  it('marks the lit ask open and the Water tab as missing something', () => {
    render(<Page lit="ask:bayask1" />);
    expect(screen.getByRole('option', { name: /Shaker cove/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const water = screen.getByRole('tab', { name: /Water/ });
    expect(water).toHaveTextContent('Missing something');
    expect(screen.getByRole('tab', { name: /Shape/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('changes tab from the grid', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<Page onTabChange={onTabChange} />);
    await user.click(screen.getByRole('tab', { name: /Hazards/ }));
    expect(onTabChange).toHaveBeenCalledWith('hazards');
  });

  it('draws the stored completeness, the towns and the outline’s trust', () => {
    render(<Page />);
    expect(screen.getByRole('meter', { name: /Complete · 9 \/ 10/ })).toHaveAttribute(
      'aria-valuenow',
      '9',
    );
    expect(screen.getByText('Missing bathymetry')).toBeInTheDocument();
    expect(screen.getByText('Enfield, NH')).toBeInTheDocument();
    expect(screen.getByText('Trusted')).toBeInTheDocument();
    expect(screen.getByText('Since 12 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('An import re-affirmed it')).toBeInTheDocument();
    expect(screen.getByText('6 changes')).toBeInTheDocument();
  });

  it('draws what was never recorded as absent — never a zero, never a guess', () => {
    render(<Page completeness={null} towns={null} trust={null} attention={new Set()} />);
    expect(screen.queryByText('Towns')).toBeNull();
    expect(screen.queryByText('Trusted')).toBeNull();
    expect(screen.queryByRole('meter', { name: /Complete/ })).toBeNull();
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
    expect(screen.queryByText(/^Missing/)).toBeNull();
    expect(screen.queryByText('Missing something')).toBeNull();
  });

  it('holds every block’s place while it loads', () => {
    const { container } = render(
      <Page
        identity={undefined}
        completeness={undefined}
        towns={undefined}
        trust={undefined}
        asks={undefined}
        history={undefined}
      />,
    );
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Asked of this body' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(1);
  });

  it('holds the record’s own blocks while the frame’s other reads load', () => {
    const { container } = render(
      <Page completeness={undefined} towns={undefined} trust={undefined} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="body-complete"]')).toHaveAttribute('aria-busy');
    expect(screen.getByText('Towns')).toBeInTheDocument();
    expect(screen.queryByText('Enfield, NH')).toBeNull();
  });

  it('says in its own place each read that failed, and tries it again', async () => {
    const user = userEvent.setup();
    const failure = (): ReadFailure => ({ failed: true, pending: false, retry: vi.fn() });
    const [complete, extras, asks, history] = [failure(), failure(), failure(), failure()];
    render(
      <Page completeness={complete} towns={extras} trust={extras} asks={asks} history={history} />,
    );
    expect(screen.getByText('Completeness couldn’t be read')).toBeInTheDocument();
    expect(
      screen.getByText('The towns and the outline’s trust couldn’t be read'),
    ).toBeInTheDocument();
    expect(screen.getByText('What is asked of this body couldn’t be read')).toBeInTheDocument();
    expect(screen.getByText('The history couldn’t be read')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Try again' });
    expect(buttons).toHaveLength(4);
    for (const b of buttons) await user.click(b);
    for (const f of [complete, extras, asks, history]) expect(f.retry).toHaveBeenCalledTimes(1);
    // The record itself still stands.
    expect(screen.getByRole('heading', { level: 1, name: 'Mascoma Lake' })).toBeInTheDocument();
  });

  it('never counts the asks, nor draws them as whole, when more wait than were read', () => {
    render(<Page asksMore />);
    expect(screen.getByText('More is asked of this body than is shown here.')).toBeInTheDocument();
    const slug = screen.getByRole('heading', { name: 'Asked of this body' }).parentElement;
    expect(slug?.textContent).not.toMatch(/3/);
  });

  it('never draws a capped history as whole', () => {
    render(<Page history={CAPPED_HISTORY} />);
    expect(screen.getByText('Latest 6')).toBeInTheDocument();
    expect(screen.queryByText(/changes?$/)).toBeNull();
    expect(screen.getByText('More history exists than is shown here.')).toBeInTheDocument();
  });

  it('says an empty history is empty, and leaves History out without the audit trail', () => {
    const { rerender } = render(<Page history={{ entries: [], capped: false }} />);
    expect(screen.getByText('Nothing recorded')).toBeInTheDocument();
    expect(screen.getByText('0 changes')).toBeInTheDocument();
    rerender(<Page history={null} />);
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull();
  });

  it('reads the boost but can’t move it without the role', () => {
    render(<Page />);
    expect(screen.getByRole('slider', { name: 'Map boost' })).toBeDisabled();
  });

  it('follows the record when the boost moves under it — an Undo, another moderator', () => {
    const { rerender } = render(<Page onBoostCommit={vi.fn()} />);
    const slider = () => screen.getByRole('slider', { name: 'Map boost' });
    expect(slider()).toHaveValue(String(MASCOMA_IDENTITY.boost.value));
    rerender(
      <Page
        identity={{ ...MASCOMA_IDENTITY, boost: { value: 0.7, note: null } }}
        onBoostCommit={vi.fn()}
      />,
    );
    expect(slider()).toHaveValue('0.7');
  });

  it('sends the moved boost, and goes back to the record when the change didn’t land', async () => {
    const user = userEvent.setup();
    const onBoostCommit = vi.fn(() => Promise.resolve(false));
    render(<Page onBoostCommit={onBoostCommit} />);
    const slider = screen.getByRole('slider', { name: 'Map boost' });
    act(() => slider.focus());
    await user.keyboard('{ArrowRight}');
    expect(onBoostCommit).toHaveBeenCalledWith(0.4);
    await waitFor(() => expect(slider).toHaveValue(String(MASCOMA_IDENTITY.boost.value)));
  });

  it('sends nothing when the boost is let go where the record already stands', () => {
    expect(boostToSend(0.3, 0.3)).toBeNull();
    expect(boostToSend(0.30000000000000004, 0.3)).toBeNull();
    expect(boostToSend(0.44, 0.3)).toBe(0.4);
    expect(boostToSend(0, 0.3)).toBe(0);
  });
});

describe('the tab slots', () => {
  it('says a tab isn’t built yet and links the old editor', () => {
    render(<NotBuiltTab label="Water" oldEditorHref="/admin/water/abc" />);
    expect(screen.getByText(/Water isn’t in the console yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Old editor →' })).toHaveAttribute(
      'href',
      '/admin/water/abc',
    );
  });

  it('says a missing body is missing, and a body whose read failed so, with Try again', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<BodyConsoleMissing state="missing" />);
    expect(screen.getByText(/No such body/)).toBeInTheDocument();
    rerender(<BodyConsoleMissing state="failed" onRetry={onRetry} />);
    expect(screen.getByText('This body couldn’t be read')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
