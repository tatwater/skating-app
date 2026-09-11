import { DEFAULT_DETAIL_TAB, DETAIL_TAB_LABELS, DETAIL_TABS } from '@skating/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { detailTabStore, useDetailTab } from './detailTabs';

/** The shape `WaterBodyDetail` uses, minus everything that needs Convex. */
function Drawer({ body }: { body: string }) {
  const [tab, setTab] = useDetailTab();
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList aria-label="Lake detail sections">
        {DETAIL_TABS.map((id) => (
          <TabsTrigger key={id} value={id}>
            {DETAIL_TAB_LABELS[id]}
          </TabsTrigger>
        ))}
      </TabsList>
      {DETAIL_TABS.map((id) => (
        <TabsContent key={id} value={id}>
          {body} · {id}
        </TabsContent>
      ))}
    </Tabs>
  );
}

afterEach(() => {
  act(() => detailTabStore.set(DEFAULT_DETAIL_TAB));
});

describe('useDetailTab', () => {
  it('opens a fresh session on the default tab', () => {
    render(<Drawer body="Willoughby" />);
    expect(
      screen.getByRole('tab', { name: DETAIL_TAB_LABELS[DEFAULT_DETAIL_TAB] }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(`Willoughby · ${DEFAULT_DETAIL_TAB}`)).toBeInTheDocument();
  });

  it('keeps the chosen tab when a different body opens — the whole point of the session store', async () => {
    const user = userEvent.setup();
    const first = render(<Drawer body="Champlain" />);
    await user.click(screen.getByRole('tab', { name: 'Planning' }));
    expect(screen.getByText('Champlain · planning')).toBeInTheDocument();
    first.unmount();

    render(<Drawer body="Willoughby" />);
    expect(screen.getByRole('tab', { name: 'Planning' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Willoughby · planning')).toBeInTheDocument();
    expect(screen.queryByText('Willoughby · overview')).not.toBeInTheDocument();
  });

  it('is one store: a change made outside React reaches a mounted drawer', () => {
    render(<Drawer body="Memphremagog" />);
    act(() => detailTabStore.set('reporting'));
    expect(screen.getByText('Memphremagog · reporting')).toBeInTheDocument();
  });

  it('renders the three tabs in the taxonomy order with the accessible wiring the library brings', () => {
    render(<Drawer body="Squam" />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Reporting', 'Planning']);
    // Only the active tab is in the tab order — roving tabindex, which is what hand-rolled buttons
    // would not have given us.
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Squam · overview');
  });
});
