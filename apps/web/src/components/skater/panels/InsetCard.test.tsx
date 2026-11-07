import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import {
  CardHead,
  CardNote,
  CardRule,
  CardSection,
  InsetCard,
  PanelColumn,
  PanelLoading,
  PanelUnavailable,
  useCardEscape,
} from './InsetCard';
import { polyfillAnimate } from './panelTestMocks';

beforeAll(polyfillAnimate);
beforeEach(() => useChromeStore.setState({ overlay: null }));
afterEach(() => vi.restoreAllMocks());

function Card({
  onClose = vi.fn(),
  backTo = 'Mascoma Lake' as string | null,
  body = <CardHead kind="Report" title="Mascoma South" where="Today · off the ice 11:40 AM" />,
  foot,
}: {
  onClose?: () => void;
  backTo?: string | null;
  body?: React.ReactNode;
  foot?: React.ReactNode;
}) {
  return (
    <PanelColumn behind={<a href="/report/r1">behind</a>}>
      <InsetCard backTo={backTo} onClose={onClose} returnKey="report:r1" label="Report" foot={foot}>
        {body}
      </InsetCard>
    </PanelColumn>
  );
}

const card = () => document.querySelector<HTMLElement>('[data-slot="inset-card"]');

describe('InsetCard', () => {
  it('heads back to the lake, names itself by its title, and moves focus in', async () => {
    render(<Card />);
    const dialog = await screen.findByRole('dialog', { name: 'Mascoma South' });
    expect(screen.getByRole('button', { name: /Back to Mascoma Lake/ })).toBeInTheDocument();
    expect(screen.getByText('Esc')).toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // It portals into the column it covers, over what's behind.
    expect(dialog.closest('[data-slot="panel-column"]')).not.toBeNull();
    expect(screen.getByText('behind')).toBeInTheDocument();
  });

  it('says only "Back" while the lake is unknown', async () => {
    render(<Card backTo={null} body={<PanelLoading />} />);
    expect(await screen.findByRole('button', { name: /^Back/ })).toHaveTextContent(/^Back/);
    expect(screen.queryByText(/Back to/)).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Report' })).toBeInTheDocument();
  });

  it('closes on Esc and on the head', async () => {
    const onClose = vi.fn();
    render(<Card onClose={onClose} />);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /Back to Mascoma Lake/ }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('never closes on a press outside it — the map beside it stays live', async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">map</button>
        <Card onClose={onClose} />
      </>,
    );
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: 'map' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves Esc to an open top-bar plate', async () => {
    const onClose = vi.fn();
    render(<Card onClose={onClose} />);
    await screen.findByRole('dialog');
    act(() => useChromeStore.setState({ overlay: 'notifications' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('lets an armed confirm inside take Esc first: one Esc per screen', async () => {
    const onClose = vi.fn();
    function Armed() {
      const [armed, setArmed] = useState(true);
      useCardEscape(armed, () => setArmed(false));
      return <p>{armed ? 'armed' : 'at rest'}</p>;
    }
    render(<Card onClose={onClose} body={<Armed />} />);
    await screen.findByText('armed');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('at rest')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('puts focus back on the row that opened it when it goes', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      fn(0);
      return 0;
    });
    function Page() {
      const [open, setOpen] = useState(true);
      return (
        <>
          {!open && (
            <a href="/report/r1" data-panel-trigger="report:r1">
              Pat’s report
            </a>
          )}
          {open && <Card onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Page />);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(card()).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Pat’s report' }));
  });

  it('rules off a foot for its actions', async () => {
    render(<Card foot={<button type="button">Helpful</button>} />);
    const foot = await waitFor(() => {
      const el = document.querySelector('[data-slot="inset-card-foot"]');
      if (el === null) throw new Error('no foot');
      return el;
    });
    expect(foot).toHaveTextContent('Helpful');
    // Report text and names never reach autocapture (D240).
    expect(document.querySelector('[data-slot="inset-card-body"]')).toHaveClass('ph-no-capture');
  });

  it('portals into a given container outside a column', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    render(
      <InsetCard
        backTo="Mascoma Lake"
        onClose={vi.fn()}
        returnKey="x"
        label="Report"
        container={host}
      >
        <p>inside</p>
      </InsetCard>,
    );
    await waitFor(() => expect(host).toHaveTextContent('inside'));
    host.remove();
  });
});

describe('card parts', () => {
  it('draws the sections, notes, rule, loading and unavailable states', async () => {
    render(
      <Card
        body={
          <>
            <CardSection label="Ice types">
              <span>Black ice</span>
            </CardSection>
            <CardNote>May have thickened or reopened since.</CardNote>
            <CardRule />
            <PanelUnavailable title="Hazard not found">
              This marker isn’t available.
            </PanelUnavailable>
          </>
        }
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Ice types' })).toBeInTheDocument();
    expect(screen.getByText('May have thickened or reopened since.')).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Hazard not found' })).toBeInTheDocument();
  });

  it('marks loading busy', async () => {
    render(<Card body={<PanelLoading />} />);
    const loading = await waitFor(() => {
      const el = document.querySelector('[data-slot="panel-loading"]');
      if (el === null) throw new Error('no loading');
      return el;
    });
    expect(loading).toHaveAttribute('aria-busy', 'true');
  });
});
