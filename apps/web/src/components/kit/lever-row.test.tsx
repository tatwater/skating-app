import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from '@/components/kit/button';

import { LeverList, LeverRow } from './lever-row';

describe('LeverRow', () => {
  it('is a group named by its key, holding its state and its action', () => {
    render(
      <LeverList>
        <LeverRow
          label="Comments"
          status="Restricted"
          tone="bad"
          action={<Button size="sm">Restore</Button>}
        />
        <LeverRow label="Reports" status="Allowed" tone="ok" />
      </LeverList>,
    );
    const comments = screen.getByRole('group', { name: 'Comments' });
    expect(within(comments).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(comments).toHaveAttribute('data-tone', 'bad');
    expect(comments.querySelector('[data-slot="lever-status"]')).toHaveClass('text-bad');
    const reports = screen.getByRole('group', { name: 'Reports' });
    expect(reports.querySelector('[data-slot="lever-status"]')).toHaveClass('text-fg1');
    expect(reports.querySelector('[data-slot="lever-detail"]')).toBeNull();
  });

  it('draws the second line across the row, and quiet by default', () => {
    render(
      <LeverRow
        label="Bounties"
        status="Limit 1"
        detail={
          <>
            This season <b>3 asks</b>
          </>
        }
      />,
    );
    const row = screen.getByRole('group', { name: 'Bounties' });
    expect(row).toHaveAttribute('data-tone', 'quiet');
    expect(row.querySelector('[data-slot="lever-detail"]')).toHaveTextContent('This season 3 asks');
    expect(row.querySelector('[data-slot="lever-status"]')).toHaveClass('text-fg3');
  });

  it('every tone has its ink', () => {
    render(
      <>
        <LeverRow label="A" status="a" tone="warn" />
        <LeverRow label="B" status="b" tone="quiet" />
      </>,
    );
    expect(
      screen.getByRole('group', { name: 'A' }).querySelector('[data-slot="lever-status"]'),
    ).toHaveClass('text-warn');
  });
});
