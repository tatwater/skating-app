import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { stubJsdomAnimations } from '@/components/admin/body/tabs/jsdomStubs';
import { ActionBar, type ActionBarGroup, barKeys } from './action-bar';

beforeAll(stubJsdomAnimations);

const button = (label: string, more: object = {}) => ({
  id: label,
  label,
  what: `${label}, in a sentence.`,
  onPress: vi.fn(),
  ...more,
});
const one = (...items: ReturnType<typeof button>[]): ActionBarGroup[] => [{ id: 'g', items }];

describe('barKeys', () => {
  it('gives each button its label’s first letter, or the key it names, or none', () => {
    const keys = barKeys(
      one(
        button('Dismiss'),
        button('hide'),
        button('Keep it', { hotkey: 'P' }),
        button('Clear', { hotkey: null }),
      ),
    );
    expect([...keys]).toEqual([
      ['Dismiss', 'D'],
      ['hide', 'H'],
      ['Keep it', 'P'],
      ['Clear', null],
    ]);
  });

  it('refuses a first letter the keyboard rules refuse (J, K, G), asking for a named key', () => {
    for (const label of ['Keep', 'Jump', 'Go']) {
      expect(() => barKeys(one(button(label)))).toThrow(/pass `hotkey`/);
    }
    expect(() => barKeys(one(button('42 more')))).toThrow(/pass `hotkey`/);
  });

  it('refuses two buttons claiming one key', () => {
    expect(() => barKeys(one(button('Remove'), button('Restore')))).toThrow(
      '"Restore" and "Remove" both claim the key R.',
    );
    expect(() => barKeys(one(button('Remove'), button('Restore', { hotkey: 'S' })))).not.toThrow();
  });
});

describe('ActionBar', () => {
  it('draws a lone action full width, and a labeled or larger bar tight to its buttons', () => {
    const { unmount } = render(<ActionBar groups={one(button('Resolve'))} aria-label="Ticket" />);
    expect(screen.getByRole('toolbar')).toHaveAttribute('data-full');
    unmount();
    render(
      <ActionBar
        groups={[{ id: 'g', label: 'Flag', items: [button('Dismiss')] }]}
        aria-label="Flag"
      />,
    );
    expect(screen.getByRole('toolbar')).not.toHaveAttribute('data-full');
    expect(screen.getByRole('toolbar')).toHaveAttribute('data-floating');
  });

  it('keeps two unlabeled buttons tight to themselves: only a lone action spans the pane', () => {
    render(<ActionBar groups={one(button('Admit'), button('Decline'))} aria-label="Request" />);
    expect(screen.getByRole('toolbar')).not.toHaveAttribute('data-full');
  });

  it('names each button by its label alone and announces its key as the shortcut', () => {
    render(
      <ActionBar
        groups={one(button('Dismiss'), button('Hide', { danger: true }))}
        aria-label="Flag"
      />,
    );
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss).toHaveAttribute('aria-keyshortcuts', 'D');
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('data-variant', 'danger');
  });

  it('parts groups with a hairline, and draws a control item as given', () => {
    render(
      <ActionBar
        aria-label="Flag"
        groups={[
          { id: 'a', label: 'Flag', items: [button('Dismiss')] },
          {
            id: 'b',
            label: 'Author',
            items: [{ kind: 'control', id: 'm', control: <span>Rob’s menu</span> }],
          },
        ]}
      />,
    );
    // (The bar seen: an unseen copy of it is measured beside it.)
    expect(
      screen.getByRole('toolbar').querySelectorAll('[data-slot="toolbar-separator"]'),
    ).toHaveLength(1);
    expect(screen.getByText('Rob’s menu')).toBeInTheDocument();
    expect(within(screen.getByRole('toolbar')).getByText('Author')).toHaveAttribute(
      'data-slot',
      'toolbar-label',
    );
  });
});
