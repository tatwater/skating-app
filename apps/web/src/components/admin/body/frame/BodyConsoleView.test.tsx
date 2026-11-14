import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReadFailure } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { BodyConsoleMissing, BodyConsoleView } from './BodyConsoleView';
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

describe('BodyConsoleView', () => {
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
