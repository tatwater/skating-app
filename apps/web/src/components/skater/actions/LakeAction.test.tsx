import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PageNav } from '../lake/lakeNav';

const seen = vi.hoisted(() => ({
  props: {} as Record<string, { onPosted?: unknown; onSearch?: unknown } & Record<string, unknown>>,
}));

vi.mock('./HazardFlow', () => ({
  HazardFlow: (p: Record<string, unknown>) => {
    seen.props.hazard = p;
    return <p>hazard flow</p>;
  },
}));
vi.mock('./ImageryPane', () => ({
  ImageryPane: (p: Record<string, unknown>) => {
    seen.props.imagery = p;
    return <p>imagery</p>;
  },
}));
vi.mock('./BountyPane', () => ({
  BountyPane: (p: Record<string, unknown>) => {
    seen.props.bounty = p;
    return <p>bounty</p>;
  },
}));

import { LakeAction } from './LakeAction';

/** The prop a mocked pane was last rendered with. */
function propOf(pane: string, name: string): unknown {
  const props = seen.props[pane];
  if (!props) throw new Error(`${pane} never rendered`);
  return props[name];
}

function nav(): PageNav {
  return {
    pathname: '/water/mascoma',
    search: '?act=imagery',
    push: vi.fn(),
    replace: vi.fn(),
    with: (edit) => `/water/mascoma?${new URLSearchParams(edit as Record<string, string>)}`,
    link: (href) => ({ href, onClick: () => {} }),
  };
}

const base = { waterBodyId: 'mascoma', lakeName: 'Mascoma Lake', backTo: 'Mascoma Lake' };

describe('the lake’s actions, routed', () => {
  it('the hazard flow sits in the action frame, framed on the bay', () => {
    const onBack = vi.fn();
    render(<LakeAction act="hazard" {...base} subAreaId="north" nav={nav()} onBack={onBack} />);
    expect(screen.getByRole('region', { name: 'Report a hazard' })).toHaveTextContent(
      'hazard flow',
    );
    expect(seen.props.hazard).toMatchObject({
      waterBodyId: 'mascoma',
      subAreaId: 'north',
      onClose: onBack,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Back to Mascoma Lake' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('the bounty is its own dialog, and a posted one opens its card', () => {
    const n = nav();
    render(<LakeAction act="bounty" {...base} nav={n} onBack={vi.fn()} />);
    expect(screen.queryByRole('region')).toBeNull();
    (propOf('bounty', 'onPosted') as (id: string) => void)('b1');
    expect(n.push).toHaveBeenCalledWith('/bounty/b1');
  });

  it('imagery carries the URL’s band and day, and writes edits back with replace', () => {
    const n = nav();
    render(
      <LakeAction act="imagery" {...base} band="vh" frame="2026-12-22" nav={n} onBack={vi.fn()} />,
    );
    expect(seen.props.imagery).toMatchObject({ band: 'vh', frame: '2026-12-22' });
    (propOf('imagery', 'onSearch') as (e: object) => void)({
      frame: '2026-12-28',
      band: undefined,
    });
    expect(n.replace).toHaveBeenCalledWith('/water/mascoma?frame=2026-12-28');
  });

  it('the access problem keeps its placeholder until it lands', () => {
    render(<LakeAction act="access-problem" {...base} nav={nav()} onBack={vi.fn()} />);
    expect(screen.getByText('Coming soon.')).toBeInTheDocument();
  });
});
