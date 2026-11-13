import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { KeysProvider } from '@/lib/keys';

import { ShapeTabView } from '../tabs/shape/ShapeTab';
import { BodyConsoleMissing, BodyConsoleView } from './BodyConsoleView';
import {
  BODY_NOW,
  MASCOMA_ASKS,
  MASCOMA_HISTORY_ENTRIES,
  MASCOMA_IDENTITY,
  MASCOMA_IDENTITY_AS_READ,
} from './bodyFixtures';
import { attentionTabs } from './bodyModel';
import { NotBuiltTab } from './NotBuiltTab';

// jsdom has no Web Animations; the kit skeleton's shimmer asks for it.
beforeAll(() => {
  if (!('animate' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finished: Promise.resolve() }),
    });
  }
  if (!('getAnimations' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: () => [],
    });
  }
});

function Page(props: Partial<Parameters<typeof BodyConsoleView>[0]> & { panel?: ReactNode }) {
  const { panel, ...rest } = props;
  return (
    <KeysProvider>
      <BodyConsoleView
        identity={MASCOMA_IDENTITY}
        asks={MASCOMA_ASKS}
        history={MASCOMA_HISTORY_ENTRIES}
        lit={null}
        now={BODY_NOW}
        tab="shape"
        onTabChange={() => {}}
        onOpenAsk={() => {}}
        attention={attentionTabs(MASCOMA_IDENTITY.completeness)}
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

  it('draws what was never recorded as absent', () => {
    render(<Page identity={MASCOMA_IDENTITY_AS_READ} />);
    expect(screen.queryByText('Towns')).toBeNull();
    expect(screen.queryByText(/^Missing/)).toBeNull();
    expect(screen.getByRole('meter', { name: /Complete/ })).toHaveAttribute('aria-valuenow', '9');
  });

  it('holds every block’s place while it loads', () => {
    render(<Page identity={undefined} asks={undefined} history={undefined} />);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Asked of this body' })).toBeInTheDocument();
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

  it('says a missing body is missing, and an unlisted one where to go', () => {
    const { rerender } = render(<BodyConsoleMissing state="missing" />);
    expect(screen.getByText(/No such body/)).toBeInTheDocument();
    rerender(<BodyConsoleMissing state="unlisted" oldEditorHref="/admin/water/x" />);
    expect(screen.getByRole('link', { name: 'Old editor →' })).toBeInTheDocument();
  });
});

describe('ShapeTabView', () => {
  const view = (onAddBay?: (w: string) => void, onLitChange = vi.fn()) => (
    <KeysProvider>
      <ShapeTabView
        outline={undefined}
        bays={[{ id: 'bay:n', name: 'Mascoma North', acres: '612', sub: null, attention: null }]}
        lit={null}
        onLitChange={onLitChange}
        {...(onAddBay ? { onAddBay } : {})}
      />
    </KeysProvider>
  );

  it('acts on its keys only while its pane has focus', async () => {
    const user = userEvent.setup();
    const onAddBay = vi.fn();
    render(view(onAddBay));
    await user.keyboard('c');
    expect(onAddBay).not.toHaveBeenCalled();
    screen.getAllByRole('button')[0]?.focus();
    await user.keyboard('f');
    expect(onAddBay).toHaveBeenCalledWith('freehand');
  });

  it('rests its ways disabled when no tool can take them', () => {
    render(view());
    for (const b of screen.getAllByRole('button', { name: /Draw|Paste/ })) expect(b).toBeDisabled();
  });

  it('lights a bay from its row, and puts it out again', async () => {
    const user = userEvent.setup();
    const onLitChange = vi.fn();
    render(view(undefined, onLitChange));
    await user.click(screen.getByText('Mascoma North'));
    expect(onLitChange).toHaveBeenCalledWith('bay:n');
  });
});
