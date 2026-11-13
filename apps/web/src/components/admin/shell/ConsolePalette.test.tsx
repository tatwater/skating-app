import { type Capability, canUse } from '@skating/core';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandItem, CommandPaletteProps } from '@/components/kit/command-palette';

const mocks = vi.hoisted(() => ({
  props: undefined as CommandPaletteProps | undefined,
  calls: [] as unknown[],
}));

vi.mock('@/components/kit/command-palette', () => ({
  CommandPalette: (props: CommandPaletteProps) => {
    mocks.props = props;
    return null;
  },
}));
vi.mock('convex/react', () => ({
  useQuery: (_ref: unknown, args: unknown) => {
    mocks.calls.push(args);
    if (args === 'skip') return undefined;
    const a = args as { query: string; bodiesOnly?: boolean };
    if (a.bodiesOnly) {
      return [{ waterBodyId: 'b1', name: 'Mascoma Lake', type: 'lake', states: ['NH'] }];
    }
    return [{ userId: 'u1', username: 'rtremblay', displayName: 'Rob Tremblay' }];
  },
}));

const { ConsolePalette, placeItems } = await import('./ConsolePalette');

const as = (role: 'moderator' | 'admin') => (c: Capability) => canUse(role, false, c, {});

beforeEach(() => {
  mocks.props = undefined;
  mocks.calls = [];
});

describe('placeItems', () => {
  it('lists the built modes, then the old pages, each only for a role that can use it', () => {
    const mod = placeItems('', as('moderator')).map((i) => i.label);
    expect(mod[0]).toBe('Overview');
    expect(mod).toContain('Flags');
    expect(mod).not.toContain('Imports');
    expect(placeItems('', as('admin')).map((i) => i.label)).toContain('Imports');
  });

  it('matches on the name, any case', () => {
    expect(placeItems('INTAKE', as('moderator')).map((i) => i.label)).toEqual(['Intake review']);
  });

  it('marks an old page as Legacy', () => {
    expect(placeItems('flags', as('moderator'))[0]?.sub).toBe('Legacy');
  });
});

describe('ConsolePalette', () => {
  const draw = (onGo = vi.fn()) => {
    render(<ConsolePalette open onOpenChange={vi.fn()} can={as('moderator')} onGo={onGo} />);
    return onGo;
  };
  const props = () => {
    if (mocks.props === undefined) throw new Error('the palette did not render');
    return mocks.props;
  };

  it('owns no ⌘K of its own — the shell has the one', () => {
    draw();
    expect(props().hotkey).toBe(false);
  });

  it('asks the server for bodies and people once typing rests', async () => {
    vi.useFakeTimers();
    try {
      draw();
      act(() => props().onQueryChange('masc'));
      expect(props().loading).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(mocks.calls).toContainEqual({ query: 'masc', limit: 6, bodiesOnly: true });
      expect(mocks.calls).toContainEqual({ query: 'masc' });
      const groups = props().groups.map((g) => g.label);
      expect(groups).toEqual(['Bodies', 'People']);
      expect(props().groups[0]?.items[0]).toMatchObject({
        label: 'Mascoma Lake',
        sub: 'Lake · NH',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes where a row points: a place, a body’s editor, a person’s page', () => {
    const onGo = draw();
    const pick = (item: Partial<CommandItem> & { id: string }) =>
      act(() => props().onSelect({ label: '', ...item }));
    pick({ id: '/admin/flags' });
    pick({ id: 'body:b1' });
    pick({ id: 'person:u1' });
    expect(onGo.mock.calls.map(([t]) => t.to)).toEqual([
      '/admin/flags',
      '/admin/water/b1',
      '/admin/users/u1',
    ]);
  });

  it('starts empty each time it closes', () => {
    const onOpenChange = vi.fn();
    render(
      <ConsolePalette open onOpenChange={onOpenChange} can={as('moderator')} onGo={vi.fn()} />,
    );
    act(() => props().onQueryChange('flags'));
    expect(props().query).toBe('flags');
    act(() => props().onOpenChange?.(false, { reason: 'escape-key' }));
    expect(props().query).toBe('');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
