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

  it('says that reports and comments survive, before anything is confirmed', () => {
    renderDelete(undefined);
    expect(screen.getByText(/reports and comments stay/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer attached to you/i)).toBeInTheDocument();
  });

  it('says nothing happens for 30 days and that it can be cancelled', () => {
    renderDelete(undefined);
    expect(screen.getByText(/Nothing happens for 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/cancel any time/i)).toBeInTheDocument();
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
    // The reassurance matters as much as the date: a pending deletion changes nothing yet.
    expect(screen.getByText(/nothing has changed/i)).toBeInTheDocument();
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
