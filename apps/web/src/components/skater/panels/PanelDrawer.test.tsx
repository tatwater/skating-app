import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChromeStore } from '@/stores/chromeStore';

import { CardHead, useCardEscape } from './InsetCard';
import { PanelDrawer, PanelDrawerHost } from './PanelDrawer';
import { polyfillAnimate } from './panelTestMocks';

beforeAll(polyfillAnimate);
beforeEach(() => useChromeStore.setState({ overlay: null }));

/** An armed confirm inside the card: Esc disarms it before it closes anything. */
function Armed() {
  const [armed, setArmed] = useState(true);
  useCardEscape(armed, () => setArmed(false));
  return <p>{armed ? 'Armed' : 'Disarmed'}</p>;
}

function Page({
  onClose = vi.fn(),
  backTo = 'Latest' as string | null,
  open = true,
  foot,
}: {
  onClose?: () => void;
  backTo?: string | null;
  open?: boolean;
  foot?: React.ReactNode;
}) {
  return (
    <PanelDrawerHost
      drawer={
        open ? (
          <PanelDrawer
            backTo={backTo}
            onClose={onClose}
            returnKey="report:r1"
            label="Report"
            foot={foot}
          >
            <CardHead kind="Report" title="Mascoma South" where="Today · off the ice 11:40 AM" />
            <Armed />
          </PanelDrawer>
        ) : undefined
      }
    >
      <a href="/latest?report=r1" data-panel-trigger="report:r1">
        Report on Mascoma South
      </a>
    </PanelDrawerHost>
  );
}

describe('PanelDrawer', () => {
  it('opens in the page it covers, names its kind once, and moves focus in', async () => {
    render(<Page foot={<button type="button">Flag</button>} />);
    const drawer = await screen.findByRole('dialog', { name: 'Mascoma South' });
    expect(drawer).toHaveAttribute('data-slot', 'panel-drawer');
    expect(drawer).toHaveAttribute('data-size', 'md');
    expect(drawer.closest('[data-slot="panel-drawer-host"]')).not.toBeNull();
    expect(within(drawer).getAllByText('Report')).toHaveLength(1);
    expect(within(drawer).getByRole('button', { name: /Back to Latest/ })).toBeInTheDocument();
    expect(drawer.querySelector('[data-slot="panel-drawer-foot"]')).toHaveTextContent('Flag');
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
  });

  it('says only "Back" while the host is unknown, and has no foot without one', async () => {
    render(<Page backTo={null} />);
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('button', { name: /^Back/ })).not.toHaveTextContent('to');
    expect(drawer.querySelector('[data-slot="panel-drawer-foot"]')).toBeNull();
  });

  it('disarms an armed confirm on the first Esc, closes on the next, and on the head', async () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Disarmed')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: /Back to Latest/ }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('puts focus back on the row that opens it when it goes', async () => {
    const { rerender } = render(<Page />);
    await screen.findByRole('dialog');
    rerender(<Page open={false} />);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Report on Mascoma South' })).toHaveFocus(),
    );
  });

  it('portals where it is told to instead, when a container is given', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    render(
      <PanelDrawer
        backTo="Latest"
        onClose={vi.fn()}
        returnKey="report:r1"
        label="Report"
        container={target}
      >
        <p>the card</p>
      </PanelDrawer>,
    );
    await waitFor(() => expect(target).toHaveTextContent('the card'));
    target.remove();
  });
});
