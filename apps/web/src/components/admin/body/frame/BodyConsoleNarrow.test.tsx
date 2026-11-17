import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KeysProvider } from '@/lib/keys';
import { measureAt, PHONE_WIDTH } from '@/test/narrowWidth';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { BodyConsoleView } from './BodyConsoleView';
import {
  BODY_NOW,
  MASCOMA_ASKS,
  MASCOMA_COMPLETENESS,
  MASCOMA_HISTORY_ENTRIES,
  MASCOMA_IDENTITY,
  MASCOMA_TOWNS,
  MASCOMA_TRUST,
} from './bodyFixtures';
import { attentionTabs } from './bodyModel';

/**
 * **The Body console under the console's narrow rule** (B01-3o): at a phone's width the three
 * columns become one pane at a time — the body first, then the map or the tab, each reached from
 * the others' heads — with focus moved by the same rule as the Bodies library and People
 * (`usePaneFocus`). Every pane stays mounted, so nothing in one is lost by going to another; the
 * map is mounted the first time it is shown and never again.
 */

beforeAll(stubJsdomAnimations);
afterEach(() => vi.restoreAllMocks());

const counts = { mapMounts: 0, tabMounts: 0 };

/** A map that counts its mounts: a switch must never create another. */
function CountedMap() {
  useEffect(() => {
    counts.mapMounts++;
  }, []);
  return <div data-testid="the-map">map</div>;
}

/** A tab holding its own state and a write out: a switch must never take either. */
function TabWithWrite({ write }: { write: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'out' | 'landed'>('idle');
  useEffect(() => {
    counts.tabMounts++;
  }, []);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setState('out');
          void write().then(() => setState('landed'));
        }}
      >
        Save in the tab
      </button>
      <span data-testid="tab-state">{state}</span>
    </div>
  );
}

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
        map={<CountedMap />}
        bodyKey="mascoma"
        {...rest}
      />
    </KeysProvider>
  );
}

const page = () => document.querySelector<HTMLElement>('[data-slot="body-console"]');
const pane = (name: string) => document.querySelector<HTMLElement>(`[data-pane="${name}"]`);
/** On screen: not hidden by the narrow rule. */
const drawn = (name: string) => !pane(name)?.classList.contains('hidden');
/** The pane on screen (jsdom draws no stylesheet: the others are hidden by class alone). */
const shownPane = () =>
  ['body', 'map', 'inspector']
    .map(pane)
    .find((p) => !p?.classList.contains('hidden')) as HTMLElement;
const go = (name: string) => userEvent.click(within(shownPane()).getByRole('button', { name }));

describe('the Body console at a phone’s width', () => {
  it('shows the body first, alone, with its way to the map and the tab', () => {
    measureAt(PHONE_WIDTH);
    render(<Page />);
    expect(page()).toHaveAttribute('data-narrow');
    expect([drawn('body'), drawn('map'), drawn('inspector')]).toEqual([true, false, false]);
    // Its head: the other two panes.
    const head = within(shownPane());
    expect(head.getByRole('button', { name: 'Show the map' })).toBeInTheDocument();
    expect(head.getByRole('button', { name: 'Show the tabs' })).toBeInTheDocument();
    expect(head.queryByRole('button', { name: 'Back to the body' })).toBeNull();
  });

  it('goes between the three, focus moving with the pane', async () => {
    measureAt(PHONE_WIDTH);
    render(<Page />);
    await go('Show the tabs');
    expect([drawn('body'), drawn('map'), drawn('inspector')]).toEqual([false, false, true]);
    expect(pane('inspector')).toHaveFocus();
    await go('Show the map');
    expect([drawn('body'), drawn('map'), drawn('inspector')]).toEqual([false, true, false]);
    expect(pane('map')).toHaveFocus();
    await go('Back to the body');
    expect([drawn('body'), drawn('map'), drawn('inspector')]).toEqual([true, false, false]);
    expect(pane('body')).toHaveFocus();
  });

  it('an ask opened from the body goes to its tab, focus in the tab’s panel', async () => {
    measureAt(PHONE_WIDTH);
    const onOpenAsk = vi.fn();
    render(<Page onOpenAsk={onOpenAsk} />);
    const asks = screen.getByRole('listbox', { name: 'Asked of this body' });
    act(() => asks.focus());
    await userEvent.keyboard('{Enter}');
    expect(onOpenAsk).toHaveBeenCalled();
    expect(drawn('inspector')).toBe(true);
    expect(drawn('body')).toBe(false);
    expect(document.querySelector('[data-slot="body-tab-panel"]')).toHaveFocus();
  });

  it('arrives on the tab when the address lights an item; another body opens on its front', async () => {
    measureAt(PHONE_WIDTH);
    const { rerender } = render(<Page lit="ask:r1" />);
    expect(drawn('inspector')).toBe(true);
    rerender(<Page lit={null} bodyKey="crystal" />);
    expect(drawn('body')).toBe(true);
    expect(drawn('inspector')).toBe(false);
  });

  it('mounts the map the first time it is shown, and never again', async () => {
    measureAt(PHONE_WIDTH);
    counts.mapMounts = 0;
    render(<Page />);
    // Hidden from the start: not created into a pane with no size.
    expect(screen.queryByTestId('the-map')).toBeNull();
    await go('Show the map');
    expect(screen.getByTestId('the-map')).toBeInTheDocument();
    await go('Show the tabs');
    await go('Back to the body');
    await go('Show the map');
    expect(counts.mapMounts).toBe(1);
    // Kept, hidden, while another pane is shown.
    await go('Back to the body');
    expect(screen.getByTestId('the-map')).toBeInTheDocument();
  });

  it('a write out in the tab lands in the tab it came from, whatever pane is shown meanwhile', async () => {
    measureAt(PHONE_WIDTH);
    counts.tabMounts = 0;
    let land: () => void = () => {};
    const write = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    render(<Page panel={<TabWithWrite write={write} />} />);
    await go('Show the tabs');
    await userEvent.click(screen.getByRole('button', { name: 'Save in the tab' }));
    expect(screen.getByTestId('tab-state')).toHaveTextContent('out');
    await go('Back to the body');
    await go('Show the tabs');
    await act(async () => land());
    expect(write).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tab-state')).toHaveTextContent('landed');
    expect(counts.tabMounts).toBe(1);
  });

  it('keeps the three columns, and draws no pane heads, where they fit', () => {
    measureAt(1_440);
    render(<Page />);
    expect(page()).not.toHaveAttribute('data-narrow');
    expect([drawn('body'), drawn('map'), drawn('inspector')]).toEqual([true, true, true]);
    expect(document.querySelector('[data-slot="body-pane-nav"]')).toBeNull();
    expect(screen.getByTestId('the-map')).toBeInTheDocument();
  });

  it('a window narrowed under the columns keeps the map it already made', () => {
    counts.mapMounts = 0;
    // Every observer the page made: the narrow rule's is one of them.
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      measureAt(1_440);
      render(<Page />);
      vi.restoreAllMocks();
      measureAt(PHONE_WIDTH);
      act(() => {
        for (const resized of observers) resized();
      });
      expect(page()).toHaveAttribute('data-narrow');
      expect(screen.getByTestId('the-map')).toBeInTheDocument();
      expect(counts.mapMounts).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
