import { DELETION_GRACE_MS } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DataExportView, DeleteAccountView, type ExportRow } from './AccountLifecycle';

/**
 * The copy is the feature. Everything below asserts what a person is told *before* they act, because
 * the two beliefs someone can reasonably arrive with — "this erases everything I wrote" and "this
 * happens immediately" — are both wrong (D33/D62), and finding that out afterwards is the failure.
 */
describe('DeleteAccountView', () => {
  function renderDelete(deletionRequestedAt: number | undefined) {
    const onRequest = vi.fn();
    const onCancel = vi.fn();
    function Wrapper() {
      const [requestedAt, setRequestedAt] = useState(deletionRequestedAt);
      return (
        <DeleteAccountView
          deletionRequestedAt={requestedAt}
          onRequest={() => {
            onRequest();
            setRequestedAt(Date.now());
          }}
          onCancel={() => {
            onCancel();
            setRequestedAt(undefined);
          }}
        />
      );
    }
    render(<Wrapper />);
    return { onRequest, onCancel };
  }

  /**
   * The single most important sentence on the screen, and the one the old copy got wrong: it used to
   * promise "nothing happens for 30 days" of an action that clears your profile and erases your older
   * reports the instant you tap. Copy that promises reversibility for something irreversible is worse
   * than no copy at all.
   */
  it('leads with what cannot be undone', () => {
    renderDelete(undefined);
    expect(screen.getByText(/happens straight away/i)).toBeInTheDocument();
    expect(screen.getByText(/can't be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/deleted for good/i)).toBeInTheDocument();
  });

  /**
   * The seam the D62 second amendment draws, asserted as copy: **what you saw stays, what you wrote
   * goes.** Someone deserves to know both halves before confirming — "delete my account" reasonably
   * reads as "delete everything I wrote", and only one of those two words is true.
   */
  it('draws the line between the observation that stays and the words that go', () => {
    renderDelete(undefined);
    expect(screen.getByText(/reports and hazards keep helping other skaters/i)).toBeInTheDocument();
    expect(screen.getByText(/notes, comments and photo captions/i)).toBeInTheDocument();
    expect(screen.getByText(/no way back to you/i)).toBeInTheDocument();
  });

  it('is honest that cancelling is not a restore', () => {
    renderDelete(undefined);
    expect(screen.getByText(/set it up again from scratch/i)).toBeInTheDocument();
  });

  it('names the 30 days as what the account gets, not what the content gets', () => {
    renderDelete(undefined);
    expect(screen.getByText(/the account itself goes in 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/you can still sign in/i)).toBeInTheDocument();
  });

  it('points at the export first — the moment after confirming is too late to mention it', () => {
    renderDelete(undefined);
    expect(screen.getByText(/Export your data first/i)).toBeInTheDocument();
  });

  it('takes two presses to request deletion', () => {
    const { onRequest } = renderDelete(undefined);
    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    expect(onRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /yes, delete my account/i }));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('backs out cleanly, leaving the account untouched', () => {
    const { onRequest } = renderDelete(undefined);
    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    fireEvent.click(screen.getByRole('button', { name: /never mind/i }));
    expect(onRequest).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^delete my account$/i })).toBeInTheDocument();
  });

  it('shows the scheduled date and a cancel control while a deletion is pending', () => {
    const requestedAt = Date.UTC(2026, 0, 1, 12, 0, 0);
    renderDelete(requestedAt);

    const expected = new Date(requestedAt + DELETION_GRACE_MS).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
    // The date is the least of it. A ghost is told what has already happened — profile cleared,
    // unfindable, older content gone — and what cancelling can and can't get back.
    expect(screen.getByText(/profile has been cleared/i)).toBeInTheDocument();
    expect(screen.getByText(/nobody can find you/i)).toBeInTheDocument();
    expect(screen.getByText(/deleted for good once it's 30 days old/i)).toBeInTheDocument();
    expect(screen.getByText(/set your profile up again from scratch/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel deletion/i })).toBeInTheDocument();
  });

  it('returns to the normal state after cancelling', () => {
    const { onCancel } = renderDelete(Date.UTC(2026, 0, 1));
    fireEvent.click(screen.getByRole('button', { name: /cancel deletion/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^delete my account$/i })).toBeInTheDocument();
  });
});

describe('DataExportView', () => {
  const ready: ExportRow = {
    exportId: 'e1',
    status: 'ready',
    requestedAt: Date.UTC(2026, 0, 1),
    expiresAt: Date.UTC(2026, 0, 8),
    sizeBytes: 2 * 1024 * 1024,
    url: 'https://example.test/bundle.json',
  };

  it('offers a download for a ready bundle', () => {
    render(<DataExportView exports={[ready]} onRequest={vi.fn()} />);
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', ready.url);
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
  });

  it('disables the button while one is building, so a double-tap costs nothing', () => {
    const onRequest = vi.fn();
    render(
      <DataExportView
        exports={[{ ...ready, status: 'building', url: null }]}
        onRequest={onRequest}
      />,
    );
    expect(screen.getByRole('button', { name: /preparing your export/i })).toBeDisabled();
  });

  /** No silent caps (Phase 7) — hardest to skip on a file someone treats as their complete record. */
  it('says so when photos were left out of a bundle', () => {
    render(<DataExportView exports={[{ ...ready, omittedPhotoCount: 3 }]} onRequest={vi.fn()} />);
    expect(screen.getByText(/3 photos too large to include/i)).toBeInTheDocument();
  });

  it('reports a failed build rather than looking like it is still working', () => {
    render(
      <DataExportView exports={[{ ...ready, status: 'failed', url: null }]} onRequest={vi.fn()} />,
    );
    expect(screen.getByText(/couldn't be prepared/i)).toBeInTheDocument();
  });
});
