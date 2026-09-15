import type { PublicAccess } from '@skating/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ConvexError } from 'convex/values';
import { describe, expect, it, vi } from 'vitest';
import { PublicAccessSectionView } from './PublicAccessSection';

/**
 * A ruling made 2026-02-01 — the date the drawer prints, and the date the gate names. Noon UTC, so
 * it is still February 1 in every timezone a test runner might sit in.
 */
const DECIDED_AT = Date.parse('2026-02-01T12:00:00Z');

const NONE: PublicAccess = {
  verdict: 'none',
  decidedAt: DECIDED_AT,
  decidedByUserId: 'mod1',
  note: 'Ringed by posted parcels; no legal approach.',
};

const OPEN: PublicAccess = { verdict: 'open', decidedAt: DECIDED_AT, decidedByUserId: 'mod1' };

type Props = Parameters<typeof PublicAccessSectionView>[0];

function renderView(overrides: Partial<Props> = {}) {
  const onReport = vi.fn(async () => undefined);
  const onRule = vi.fn(async () => undefined);
  render(
    <PublicAccessSectionView
      access={undefined}
      pendingCount={0}
      alreadyReported={false}
      ready
      canModerate={false}
      onReport={onReport}
      onRule={onRule}
      {...overrides}
    />,
  );
  return { onReport, onRule };
}

describe('PublicAccessSectionView — the three states', () => {
  it('says nothing at all on the unruled, unreported majority until the viewer is known', () => {
    const { container } = render(
      <PublicAccessSectionView
        access={undefined}
        pendingCount={0}
        alreadyReported={false}
        ready={false}
        canModerate={false}
        onReport={async () => undefined}
        onRule={async () => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('a "none" ruling prints the line, the note, and no report button', () => {
    renderView({ access: NONE });
    expect(
      screen.getByText('No public access — every approach crosses private land.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Ringed by posted parcels; no legal approach.')).toBeInTheDocument();
    // The body already says so; a report would be a claim about a settled fact.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('an "open" ruling says so out loud, with the date, and still offers the report', () => {
    renderView({ access: OPEN });
    expect(
      screen.getByText('A moderator reviewed this on February 1, 2026 and found public access.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Report no public access' })).toBeInTheDocument();
  });

  it('pending reports show while unruled, and the button turns into corroboration', () => {
    renderView({ pendingCount: 3 });
    expect(
      screen.getByText('3 people have reported no public access here — under review.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: "Confirm — I've been turned away" }),
    ).toBeInTheDocument();
  });

  it('once ruled, the count is history — the verdict is the answer', () => {
    renderView({ access: NONE, pendingCount: 3 });
    expect(screen.queryByText(/people have reported/)).toBeNull();
  });

  it('acknowledges the viewer’s own claim instead of offering a no-op button', () => {
    renderView({ pendingCount: 1, alreadyReported: true });
    expect(screen.getByText(/You reported this — it's with the moderators/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('PublicAccessSectionView — reporting', () => {
  it('files a report with the note trimmed, or with no note at all', async () => {
    const { onReport } = renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Report no public access' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(onReport).toHaveBeenCalledWith(undefined);
  });

  it('under an "open" verdict the note is compulsory — Send stays disabled until it is written', async () => {
    const { onReport } = renderView({ access: OPEN });
    fireEvent.click(screen.getByRole('button', { name: 'Report no public access' }));

    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(
      screen.getByPlaceholderText('What changed since the review? (required)'),
    ).toBeInTheDocument();

    // Whitespace is not a note — the server refuses it, so the client should not offer it.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '  A gate went up in March.  ' },
    });
    expect(send).toBeEnabled();
    await act(async () => {
      fireEvent.click(send);
    });
    expect(onReport).toHaveBeenCalledWith('A gate went up in March.');
  });

  it('surfaces the server’s gate message verbatim when a report is refused', async () => {
    const refusal =
      'A moderator reviewed this on February 1, 2026 and found public access. If that has changed, say what changed.';
    renderView({
      onReport: async () => {
        throw new ConvexError(refusal);
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Report no public access' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    });
    expect(screen.getByText(refusal)).toBeInTheDocument();
    // The form stays open with the note intact — the refusal is an instruction, not a dismissal.
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});

describe('PublicAccessSectionView — the moderator', () => {
  it('rules directly, and the button for the standing verdict is disabled', async () => {
    const { onRule } = renderView({ access: NONE, canModerate: true });
    expect(screen.getByRole('button', { name: 'Mark no public access' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm public access' }));
    });
    expect(onRule).toHaveBeenCalledWith('open');
  });

  it('can clear a ruling back to unruled, and cannot clear what was never ruled', async () => {
    const { onRule } = renderView({ access: OPEN, canModerate: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    expect(onRule).toHaveBeenCalledWith(null);
  });

  it('offers no Clear on an unruled body', () => {
    renderView({ canModerate: true });
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    // A moderator sees the controls even on a body nobody has reported.
    expect(screen.getByRole('button', { name: 'Mark no public access' })).toBeEnabled();
  });

  it('a failed ruling says so rather than failing silently', async () => {
    renderView({
      canModerate: true,
      onRule: async () => {
        throw new ConvexError('Water body not found');
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark no public access' }));
    });
    expect(screen.getByText('Water body not found')).toBeInTheDocument();
  });
});
