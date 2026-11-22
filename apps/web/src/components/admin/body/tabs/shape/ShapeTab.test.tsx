import { AUDIT_REASON_MAX } from '@skating/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReadFailure } from '@/components/admin/reads/consoleReads';
import { KeysProvider } from '@/lib/keys';
import { expectNoBlanks } from '@/test/blanksAudit';
import { expectKeyboardOperable } from '@/test/keyboardAudit';
import { stubJsdomAnimations } from '../jsdomStubs';
import type { MergeFlowProps } from './MergeFlow';
import { MERGE_HEAVY, MERGE_REFUSED, MERGE_TO_CRYSTAL } from './mergeFixtures';
import { ShapeTabView, type ShapeTabViewProps } from './ShapeTab';
import { CAPPED_SOME, NOT_COMPUTED_YET, BAY_NOT_RECORDED as NOT_RECORDED } from './shapeModel';

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
        bays: [
          { id: 'bay:x', name: 'Shaker cove', acres: '0.4', sub: NOT_RECORDED, attention: null },
          // How it was made not yet read (or withheld): no sub-line, and no claim about the record.
          { id: 'bay:y', name: 'Fish bay', acres: '3', sub: null, attention: null },
        ],
        merge: { touching: [{ id: 'k2', name: 'Unnamed body', lit: 'neighbor:k2' }], note: null },
        bodyLink: (id) => <a href={`/admin/body/${id}`}>Open</a>,
      }),
    );
    expectNoBlanks(container);
    // A bay made with nothing recorded about how says so, rather than standing bare.
    expect(
      within(container.querySelector('[data-id="bay:x"]') as HTMLElement).getByText(NOT_RECORDED),
    ).toBeInTheDocument();
    const unread = container.querySelector('[data-id="bay:y"]') as HTMLElement;
    expect(within(unread).queryByText(NOT_RECORDED)).toBeNull();
    expect(unread.querySelector('td')?.textContent).toBe('Fish bay');
  });

  it('never says *Not recorded yet* beside a note that how each bay was made couldn’t be read', () => {
    render(
      view({
        bays: [{ id: 'bay:x', name: 'Shaker cove', acres: '0.4', sub: null, attention: null }],
        baysMadeFailed: failure(),
      }),
    );
    expect(screen.getByText('How each bay was made couldn’t be read')).toBeInTheDocument();
    expect(screen.queryByText(NOT_RECORDED)).toBeNull();
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

  it('lists each body that touches it — a press lights it, a link opens it — and offers no merge to a viewer who can’t', async () => {
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
    // No flow passed (no `corpus.duplicates`): no search, no confirm, no stub.
    expect(within(merge).queryByRole('searchbox')).toBeNull();
    expect(within(merge).queryByRole('button', { name: /Merge into|Choose a body/ })).toBeNull();
  });

  it('says what the touching test couldn’t check, never that nothing touches', () => {
    const { rerender } = render(view({ merge: { touching: [], note: NOT_COMPUTED_YET } }));
    expect(screen.getByText(NOT_COMPUTED_YET)).toBeInTheDocument();
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

describe('the merge itself', () => {
  const neighbors = [{ lit: 'neighbor:k1', id: 'k1', name: 'Crystal Lake' }];
  const flow = (over: Partial<MergeFlowProps> = {}): MergeFlowProps => ({
    survivor: null,
    onPick: vi.fn(),
    query: '',
    onQueryChange: vi.fn(),
    hits: null,
    preview: undefined,
    bodyName: 'Mascoma Lake',
    onMerge: vi.fn(async () => true),
    ...over,
  });
  const region = () => screen.getByRole('region', { name: 'Merge into another body' });

  it('picks a touching body as the survivor; pressed again, none — the route lights the map from the pick', async () => {
    const user = userEvent.setup();
    const onLitChange = vi.fn();
    const onPick = vi.fn();
    const { rerender } = render(
      view({
        merge: { touching: neighbors, note: null },
        onLitChange,
        mergeFlow: flow({ onPick }),
      }),
    );
    await user.click(within(region()).getByText('Crystal Lake'));
    expect(onPick).toHaveBeenCalledWith({ id: 'k1', name: 'Crystal Lake' });
    // One piece of state: the pick. The view never lights a survivor itself.
    expect(onLitChange).not.toHaveBeenCalled();
    rerender(
      view({
        merge: { touching: neighbors, note: null },
        onLitChange,
        mergeFlow: flow({ onPick, survivor: { id: 'k1', name: 'Crystal Lake' } }),
      }),
    );
    // The picked row is the selected one, whatever is lit.
    expect(region().querySelector('tr[data-id="neighbor:k1"]')).toHaveAttribute('data-selected');
    await user.click(within(region()).getAllByText('Crystal Lake')[0] as HTMLElement);
    expect(onPick).toHaveBeenLastCalledWith(null);
    expect(onLitChange).not.toHaveBeenCalled();
  });

  it('finds a survivor by name: the hits, none, the search failed; a hit pressed is picked', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onQueryChange = vi.fn();
    const merge = { touching: neighbors, note: null };
    const { rerender } = render(view({ merge, mergeFlow: flow({ onQueryChange }) }));
    await user.type(within(region()).getByRole('searchbox'), 'p');
    expect(onQueryChange).toHaveBeenCalledWith('p');
    const hits = [
      { id: 'kpost', name: 'Post Pond', sub: 'Pond · NH' },
      { id: 'kpost2', name: 'Post Pond', sub: 'Pond · VT' },
    ];
    rerender(view({ merge, mergeFlow: flow({ onPick, query: 'post', hits }) }));
    // Two of one name told apart by their kind and states; the second pressed is the one picked.
    expect(within(region()).getByText('Pond · VT')).toBeInTheDocument();
    await user.click(within(region()).getByText('Pond · VT'));
    expect(onPick).toHaveBeenCalledWith({ id: 'kpost2', name: 'Post Pond' });
    rerender(view({ merge, mergeFlow: flow({ query: 'zzz', hits: [] }) }));
    expect(within(region()).getByText('No body by that name')).toBeInTheDocument();
    const failed = failure();
    rerender(view({ merge, mergeFlow: flow({ query: 'post', hits: failed }) }));
    expect(within(region()).getByText('The search couldn’t be read')).toBeInTheDocument();
    await user.click(within(region()).getByRole('button', { name: 'Try again' }));
    expect(failed.retry).toHaveBeenCalledTimes(1);
  });

  it('previews what moves, what it runs into and what stays, from the server’s answer', () => {
    render(
      view({
        merge: { touching: neighbors, note: null },
        mergeFlow: flow({
          survivor: { id: 'k1', name: 'Crystal Lake' },
          preview: MERGE_TO_CRYSTAL,
        }),
      }),
    );
    const preview = screen.getByRole('region', { name: 'Into Crystal Lake' });
    expect(preview).toHaveTextContent('Reports 3');
    expect(preview).toHaveTextContent('Skates 1');
    expect(preview).toHaveTextContent('1 favorite already on Crystal Lake');
    expect(preview).toHaveTextContent('West cove · Crystal Lake has a bay by that name');
    expect(preview).toHaveTextContent('Pins 3 of 10 · Aliases 4 of 20 · Links 2 of 10');
    expect(preview).toHaveTextContent('1 access alert · 2 linked lots');
    expect(within(preview).getByRole('button', { name: 'Merge into Crystal Lake' })).toBeEnabled();
    expect(within(preview).queryByRole('note')).toBeNull();
  });

  it('a merge too heavy for one go says so, and the confirm can’t be pressed', () => {
    const onMerge = vi.fn(async () => true);
    render(
      view({
        merge: { touching: neighbors, note: null },
        mergeFlow: flow({
          survivor: { id: 'k1', name: 'Crystal Lake' },
          preview: MERGE_HEAVY,
          onMerge,
        }),
      }),
    );
    const preview = screen.getByRole('region', { name: 'Into Crystal Lake' });
    expect(within(preview).getByRole('note')).toHaveTextContent(MERGE_HEAVY.refusal as string);
    expect(preview).toHaveTextContent('Reports 1,000+');
    const confirm = within(preview).getByRole('button', { name: 'Merge into Crystal Lake' });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('a refused preview is the server’s sentence, and no confirm; loading and failed, none either', async () => {
    const user = userEvent.setup();
    const survivor = { id: 'k1', name: 'Crystal Lake' };
    const merge = { touching: neighbors, note: null };
    const { rerender } = render(
      view({ merge, mergeFlow: flow({ survivor, preview: MERGE_REFUSED }) }),
    );
    const confirm = () => screen.getByRole('button', { name: 'Merge into Crystal Lake' });
    expect(screen.getByRole('note')).toHaveTextContent(
      'Survivor is itself merged — pick the canonical body',
    );
    expect(confirm()).toBeDisabled();
    rerender(view({ merge, mergeFlow: flow({ survivor, preview: undefined }) }));
    expect(confirm()).toBeDisabled();
    const failed = failure();
    rerender(view({ merge, mergeFlow: flow({ survivor, preview: failed }) }));
    expect(screen.getByText('What the merge would move couldn’t be read')).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(failed.retry).toHaveBeenCalledTimes(1);
  });

  it('asks a reason before it merges — required, the audit log’s cap — and sends it', async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn(async () => true);
    render(
      view({
        merge: { touching: neighbors, note: null },
        mergeFlow: flow({
          survivor: { id: 'k1', name: 'Crystal Lake' },
          preview: MERGE_TO_CRYSTAL,
          onMerge,
        }),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Merge into Crystal Lake' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Merge Mascoma Lake into Crystal Lake');
    expect(within(dialog).getByText('Reason · kept in the audit log')).toBeInTheDocument();
    const box = within(dialog).getByRole('textbox');
    expect(box).toHaveAttribute('maxlength', String(AUDIT_REASON_MAX));
    // Required: nothing is sent without one.
    const send = within(dialog).getByRole('button', { name: 'Merge' });
    await user.click(send);
    expect(onMerge).not.toHaveBeenCalled();
    await user.type(box, '  Drawn twice  ');
    await user.click(send);
    await waitFor(() => expect(onMerge).toHaveBeenCalledWith('Drawn twice'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('unpicks from the preview', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      view({
        merge: { touching: neighbors, note: null },
        mergeFlow: flow({ survivor: { id: 'k1', name: 'Crystal Lake' }, onPick }),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Pick another' }));
    expect(onPick).toHaveBeenCalledWith(null);
  });
});
