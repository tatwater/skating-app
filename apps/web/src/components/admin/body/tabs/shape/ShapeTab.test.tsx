import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReadFailure } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { expectNoBlanks } from '@/test/blanksAudit';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import { stubJsdomAnimations } from '../jsdomStubs';
import { ShapeTabView, type ShapeTabViewProps } from './ShapeTab';
import { CAPPED_SOME, NOT_CHECKED } from './shapeModel';

beforeAll(stubJsdomAnimations);

const OUTLINE = {
  source: { name: 'OpenStreetMap', tag: 'OSM' },
  rings: 'The shore and 3 islands',
  vertices: '234 vertices',
  lastImport: '12 Oct campaign',
};
const BAYS = [
  {
    id: 'bay:n',
    name: 'Mascoma North',
    acres: '612',
    sub: 'Seeded · 2 Sep · Teagan',
    attention: null,
  },
];

function view(props: Partial<ShapeTabViewProps> = {}) {
  return (
    <KeysProvider>
      <ShapeTabView outline={OUTLINE} bays={BAYS} lit={null} onLitChange={() => {}} {...props} />
    </KeysProvider>
  );
}

const failure = (): ReadFailure => ({ failed: true, pending: false, retry: vi.fn() });

describe('ShapeTabView', () => {
  it('leaves nothing blank when every fact the record may lack is absent', () => {
    const { container } = render(
      view({
        outline: { ...OUTLINE, lastImport: null },
        bays: [{ id: 'bay:x', name: 'Shaker cove', acres: '0.4', sub: null, attention: null }],
        merge: { touching: [{ id: 'k2', name: 'Unnamed body', lit: 'neighbor:k2' }], note: null },
        bodyLink: (id) => <a href={`/admin/body/${id}`}>Open</a>,
      }),
    );
    expectNoBlanks(container);
    // A bay made with nothing recorded about how says so, rather than standing bare.
    expect(
      within(container.querySelector('[data-id="bay:x"]') as HTMLElement).getByText(
        'Not recorded yet',
      ),
    ).toBeInTheDocument();
  });

  it('answers the keyboard wherever it answers a click: bays, touching bodies, the ways', () => {
    const onLitChange = vi.fn();
    const { container } = render(
      view({
        onLitChange,
        onAddBay: () => {},
        merge: {
          touching: [{ id: 'k2', name: 'Mascoma North Pond', lit: 'neighbor:k2' }],
          note: null,
        },
        bodyLink: (id) => <a href={`/admin/body/${id}`}>Open</a>,
      }),
    );
    expect(expectKeyboardOperable(container).length).toBeGreaterThanOrEqual(5);
    // A bay row is a Tab stop, and ⏎ lights it as a press does.
    const row = container.querySelector<HTMLElement>('[data-id="bay:n"]');
    expect(row).toHaveAttribute('tabindex', '0');
    row?.focus();
    fireEvent.keyDown(row as HTMLElement, { key: 'Enter' });
    expect(onLitChange).toHaveBeenLastCalledWith('bay:n');
    const neighbor = container.querySelector<HTMLElement>('[data-id="neighbor:k2"]');
    neighbor?.focus();
    fireEvent.keyDown(neighbor as HTMLElement, { key: ' ' });
    expect(onLitChange).toHaveBeenLastCalledWith('neighbor:k2');
  });

  it('draws the outline and the bays, each bay saying how and when it was made', () => {
    render(view());
    expect(screen.getByText('OpenStreetMap')).toBeInTheDocument();
    expect(screen.getByText('234 vertices')).toBeInTheDocument();
    expect(screen.getByText('Seeded · 2 Sep · Teagan')).toBeInTheDocument();
  });

  it('acts on its keys only while its pane has focus', async () => {
    const user = userEvent.setup();
    const onAddBay = vi.fn();
    render(view({ onAddBay }));
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
    const { rerender } = render(view({ onLitChange }));
    await user.click(screen.getByText('Mascoma North'));
    expect(onLitChange).toHaveBeenLastCalledWith('bay:n');
    rerender(view({ onLitChange, lit: 'bay:n' }));
    await user.click(screen.getByText('Mascoma North'));
    expect(onLitChange).toHaveBeenLastCalledWith(null);
  });

  it('holds each block’s place while it loads, and says a body with no bays has none', () => {
    const { container, rerender } = render(view({ outline: undefined, bays: undefined }));
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(2);
    rerender(view({ bays: [] }));
    expect(screen.getByText('No bays')).toBeInTheDocument();
  });

  it('says in its own place each read that failed, and tries it again', async () => {
    const user = userEvent.setup();
    const [outline, bays] = [failure(), failure()];
    render(view({ outline, bays }));
    expect(screen.getByText('The outline couldn’t be read')).toBeInTheDocument();
    expect(screen.getByText('The bays couldn’t be read')).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { name: 'Try again' })) await user.click(b);
    expect(outline.retry).toHaveBeenCalledTimes(1);
    expect(bays.retry).toHaveBeenCalledTimes(1);
  });

  it('keeps the bays when only how they were made couldn’t be read', async () => {
    const user = userEvent.setup();
    const made = failure();
    render(view({ baysMadeFailed: made }));
    expect(screen.getByText('Mascoma North')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(made.retry).toHaveBeenCalledTimes(1);
  });
});

describe('Merge into another body', () => {
  const neighbors = [{ lit: 'neighbor:k1', id: 'k1', name: 'Crystal Lake' }];

  it('is left out while nothing touches the body, and while the test is read', () => {
    const { rerender } = render(view({ merge: null }));
    expect(screen.queryByRole('heading', { name: 'Merge into another body' })).toBeNull();
    rerender(view({ merge: undefined }));
    expect(screen.queryByRole('heading', { name: 'Merge into another body' })).toBeNull();
  });

  it('lists each body that touches it — a press lights it, a link opens it — and the merge isn’t built', async () => {
    const user = userEvent.setup();
    const onLitChange = vi.fn();
    render(
      view({
        merge: { touching: neighbors, note: null },
        onLitChange,
        // biome-ignore lint/a11y/useAnchorContent: the link takes its words from what renders it.
        bodyLink: (id) => <a href={`/admin/body/${id}`} />,
      }),
    );
    const merge = screen.getByRole('region', { name: 'Merge into another body' });
    await user.click(within(merge).getByText('Crystal Lake'));
    expect(onLitChange).toHaveBeenCalledWith('neighbor:k1');
    const open = within(merge).getByRole('link', { name: 'Open →' });
    expect(open).toHaveAttribute('href', '/admin/body/k1');
    onLitChange.mockClear();
    await user.click(open);
    expect(onLitChange).not.toHaveBeenCalled();
    const choose = within(merge).getByRole('button', { name: 'Choose a body' });
    expect(choose).toHaveAttribute('aria-disabled', 'true');
    await user.hover(choose);
    await waitFor(() => expect(screen.getAllByText('Not available yet').length).toBeGreaterThan(0));
  });

  it('says what the touching test couldn’t check, never that nothing touches', () => {
    const { rerender } = render(view({ merge: { touching: [], note: NOT_CHECKED } }));
    expect(screen.getByText(NOT_CHECKED)).toBeInTheDocument();
    rerender(view({ merge: { touching: neighbors, note: CAPPED_SOME } }));
    expect(screen.getByText(CAPPED_SOME)).toBeInTheDocument();
  });

  it('says so when the test, or the touching bodies, couldn’t be read', async () => {
    const user = userEvent.setup();
    const extras = failure();
    const { rerender } = render(view({ merge: extras }));
    expect(
      screen.getByText('Whether another body touches this one couldn’t be read'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(extras.retry).toHaveBeenCalledTimes(1);
    const touching = failure();
    rerender(view({ merge: { touching, note: null } }));
    expect(screen.getByText('The bodies that touch this one couldn’t be read')).toBeInTheDocument();
    rerender(view({ merge: { touching: undefined, note: null } }));
    expect(screen.getByRole('heading', { name: 'Merge into another body' })).toBeInTheDocument();
  });
});
