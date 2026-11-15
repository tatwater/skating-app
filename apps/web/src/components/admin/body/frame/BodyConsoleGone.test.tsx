import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReadFailure } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { stubJsdomAnimations } from '../tabs/jsdomStubs';
import { BodyConsoleGone, type BodyConsoleGoneProps } from './BodyConsoleGone';
import { BODY_NOW, CAPPED_HISTORY } from './bodyFixtures';
import { NOT_COMPUTED } from './bodyModel';

beforeAll(stubJsdomAnimations);

const REJECTED: BodyConsoleGoneProps = {
  survivor: null,
  removal: { verb: 'Rejected', when: '2 Oct 2026', who: 'Teagan', reason: 'Drawn over a beach' },
  towns: ['Enfield, NH'],
  reports: { count: 1000, capped: true },
  history: { entries: [], capped: false },
  record: null,
  now: BODY_NOW,
};

const page = (props: Partial<BodyConsoleGoneProps> = {}) => (
  <KeysProvider>
    <BodyConsoleGone {...REJECTED} {...props} />
  </KeysProvider>
);

const failure = (): ReadFailure => ({ failed: true, pending: false, retry: vi.fn() });

describe('BodyConsoleGone', () => {
  it('says a rejected body has been removed, and how, by whom and why', () => {
    render(page());
    expect(screen.getByText(/This body has been removed/)).toBeInTheDocument();
    expect(screen.getByText(/what its record still holds is below/)).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Teagan')).toBeInTheDocument();
    expect(screen.getByText('“Drawn over a beach”')).toBeInTheDocument();
    // A capped count is a floor, never a total.
    expect(screen.getByText('1,000+ since the record began')).toBeInTheDocument();
  });

  it('says a removal’s listed reason beside the row’s own words', () => {
    render(
      page({
        removal: {
          verb: 'Removed',
          when: '2 Oct 2026',
          who: 'Teagan',
          reason: 'Posted by the owner',
          because: 'Landowner request',
        },
      }),
    );
    expect(screen.getByText('Landowner request')).toBeInTheDocument();
    expect(screen.getByText('“Posted by the owner”')).toBeInTheDocument();
  });

  it('holds each fact’s place while its read is on its way', () => {
    const { container } = render(
      page({ removal: undefined, towns: undefined, reports: undefined, history: undefined }),
    );
    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(4);
  });

  it('says once when the record’s facts couldn’t be read, and tries each again', async () => {
    const user = userEvent.setup();
    const [towns, reports] = [failure(), failure()];
    render(page({ towns, reports }));
    expect(screen.getByText('What the record holds about it couldn’t be read')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(towns.retry).toHaveBeenCalledTimes(1);
    expect(reports.retry).toHaveBeenCalledTimes(1);
  });

  it('says a failed history once, in History, and leaves the removal row out', () => {
    render(page({ removal: failure(), history: failure() }));
    expect(screen.getByText('The history couldn’t be read')).toBeInTheDocument();
    expect(screen.queryByText('Rejected')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
  });

  it('never draws a capped history as whole', () => {
    render(page({ history: CAPPED_HISTORY }));
    expect(screen.getByText('More history exists than is shown here.')).toBeInTheDocument();
  });

  it('says a rejected body’s towns aren’t computed yet, and that it is in no town — never a blank', () => {
    const { rerender } = render(page({ towns: NOT_COMPUTED }));
    expect(screen.getByText('Not computed yet')).toBeInTheDocument();
    expect(screen.queryByText('In no town')).toBeNull();
    rerender(page({ towns: [] }));
    expect(screen.getByText('In no town')).toBeInTheDocument();
    expect(screen.queryByText('Not computed yet')).toBeNull();
  });

  it('leaves out what isn’t recorded, and History without the audit trail', () => {
    render(page({ towns: null, reports: null, history: null }));
    expect(screen.queryByText('Towns')).toBeNull();
    expect(screen.queryByText('Reports')).toBeNull();
    expect(screen.queryByText('Rejected')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull();
  });

  it('points a merged body at the one that took it in, and goes back to the list on ⇧⏎', async () => {
    const user = userEvent.setup();
    const onReturn = vi.fn();
    render(
      page({
        survivor: { id: 'k1', name: 'Mascoma Lake' },
        removal: { verb: 'Merged', when: '2 Oct 2026', who: null, reason: null },
        towns: null,
        reports: null,
        // biome-ignore lint/a11y/useAnchorContent: the link takes its words from what renders it.
        survivorLink: (id) => <a href={`/admin/body/${id}`} />,
        onReturn,
      }),
    );
    expect(screen.getByText(/This body was merged into/)).toBeInTheDocument();
    expect(screen.getByText('Merged')).toBeInTheDocument();
    const open = screen.getByRole('link', { name: 'Open Mascoma Lake' });
    expect(open).toHaveAttribute('href', '/admin/body/k1');
    open.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('draws what the stored record still holds — name, class, states, area — and not recorded for an unknown area', () => {
    const { rerender } = render(
      page({
        record: { name: 'Mascoma Lake', kind: 'Lake', states: ['NH'], area: '1,143 ac' },
      }),
    );
    expect(document.querySelector('[data-slot="body-gone-name"]')).toHaveTextContent(
      'Mascoma Lake',
    );
    expect(screen.getByText('1,143 ac')).toBeInTheDocument();
    rerender(page({ record: { name: 'Mascoma Lake', kind: 'Lake', states: [], area: null } }));
    expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
  });
});
