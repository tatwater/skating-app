import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDownload, faRotateLeft, faTrash } from '@fortawesome/sharp-light-svg-icons';
import {
  DATA_EXPORT_TTL_DAYS,
  DELETION_GRACE_DAYS,
  DELETION_GRACE_MS,
  DEPARTED_CONTENT_MAX_AGE_DAYS,
} from '@skating/core';
import { type ReactNode, useState } from 'react';

import { Button, buttonVariants } from '../../kit/button';
import { Section } from '../../kit/section-slug';
import { FormLine } from '../auth/SystemStage';
import { INK_PRIMARY } from '../styles';
import { Actions, BlockText, PaneHead } from './SettingsParts';

export interface ExportRow {
  exportId: string;
  status: 'building' | 'ready' | 'failed';
  requestedAt: number;
  expiresAt: number;
  sizeBytes?: number;
  omittedPhotoCount?: number;
  expired?: boolean;
  url: string | null;
}

/** "Jan 4, 2027" */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "48 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** What an export row says about itself, past its date. */
export function exportLine(row: ExportRow): { status: string; detail: string | null } {
  if (row.status === 'building') return { status: 'Preparing', detail: null };
  if (row.status === 'failed') return { status: 'Couldn’t be prepared', detail: 'Try again' };
  if (row.expired || row.url === null) return { status: 'Expired', detail: null };
  const parts = [
    row.sizeBytes !== undefined ? formatBytes(row.sizeBytes) : null,
    `expires ${new Date(row.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    row.omittedPhotoCount
      ? `${row.omittedPhotoCount} photo${row.omittedPhotoCount === 1 ? '' : 's'} too large to include`
      : null,
  ].filter(Boolean);
  return { status: 'Ready', detail: parts.join(' · ') };
}

/**
 * Data and account (7.12–7.14, D33/D62): take a copy, or leave. Export comes first because the
 * person deleting an account is the one most likely to want their record. The delete copy leads
 * with what can't be undone and names what survives (the reports, under "Deleted skater") — that's
 * the feature. The second step is red; the first is not.
 */
export function DataSection({
  exports,
  deletionRequestedAt,
  exportBusy,
  deleteBusy,
  failed,
  onExport,
  onDelete,
  onCancelDeletion,
}: {
  exports: ExportRow[];
  deletionRequestedAt: number | undefined;
  exportBusy: boolean;
  deleteBusy: boolean;
  failed: string | null;
  onExport: () => void;
  onDelete: () => void;
  onCancelDeletion: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const pending = deletionRequestedAt !== undefined;
  const building = exports.some((e) => e.status === 'building');

  const exportBlock = (
    <Section title="Export my data">
      <BlockText muted>
        Download everything we hold about you as a JSON file — your profile, reports, comments,
        hazards, recorded tracks, and your photos. We’ll email you a link when it’s ready, and list
        it here too. Links expire after {DATA_EXPORT_TTL_DAYS} days — including if you delete your
        account in the meantime.
      </BlockText>
      <Actions>
        <Button
          onClick={onExport}
          loading={exportBusy}
          disabled={building}
          data-attr="settings-export"
        >
          <FontAwesomeIcon icon={faDownload} aria-hidden="true" />
          {building ? 'Preparing your export' : 'Export my data'}
        </Button>
      </Actions>
      {exports.length > 0 && (
        <ul
          aria-label="Your exports"
          className="m-0 flex list-none flex-col border-0 border-line border-t border-solid p-0 [&>li:last-child]:border-b-0"
        >
          {exports.map((row) => {
            const line = exportLine(row);
            return (
              <li
                key={row.exportId}
                className="flex min-h-[3rem] items-center gap-(--space-3_5) border-0 border-line border-b border-solid text-fg1 text-row"
              >
                <span className="w-[7.5rem] flex-none font-(family-name:--family-mono) text-fg2 text-mono-sm">
                  {shortDate(row.requestedAt)}
                </span>
                <span className={line.status === 'Ready' ? 'text-fg1' : 'text-fg3'}>
                  {line.status}
                </span>
                {line.detail && <span className="text-assist text-fg3">{line.detail}</span>}
                {line.status === 'Ready' && row.url && (
                  <a
                    href={row.url}
                    download
                    className={buttonVariants({ size: 'sm', className: 'ml-auto' })}
                  >
                    <FontAwesomeIcon icon={faDownload} aria-hidden="true" />
                    Download
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );

  if (pending) {
    return (
      <>
        <PaneHead title="Your data and account" />
        <DangerBox>
          <p className="m-0 text-body text-fg">
            Your account will be deleted on{' '}
            <b className="font-semibold">{longDay(deletionRequestedAt + DELETION_GRACE_MS)}</b>.
          </p>
          <p className="m-0">
            Your profile has been cleared and nobody can find you on here any more. Your reports and
            hazards are still helping other skaters, under “Deleted skater” — but anything you wrote
            alongside them is deleted for good once it’s {DEPARTED_CONTENT_MAX_AGE_DAYS} days old:
            your notes, your comments, your photo captions. You can browse, but not post.
          </p>
          <p className="m-0">
            Canceling keeps the account and stops the deletion. It <b>can’t</b> bring back your
            profile or the words already deleted — you’d set your profile up again from scratch.
          </p>
          {failed && <FormLine>{failed}</FormLine>}
          <Actions>
            <Button
              variant="primary"
              className={INK_PRIMARY}
              loading={deleteBusy}
              onClick={onCancelDeletion}
              data-attr="settings-cancel-deletion"
            >
              <FontAwesomeIcon icon={faRotateLeft} aria-hidden="true" />
              Cancel deletion
            </Button>
          </Actions>
        </DangerBox>
        {exportBlock}
      </>
    );
  }

  return (
    <>
      <PaneHead title="Your data and account">
        Take a copy of what you’ve given us, or leave.
      </PaneHead>
      {exportBlock}
      <Section title="Delete my account">
        <DangerBox>
          <p className="m-0">
            <b>This happens straight away, and most of it can’t be undone.</b> Your profile — name,
            photo, bio, town, home location — is cleared immediately, and nobody will be able to
            find you on here.
          </p>
          <p className="m-0">
            What you <b>saw</b> stays: your reports and hazards keep helping other skaters, under
            “Deleted skater”, with no way back to you. What you <b>wrote</b> goes — your notes,
            comments, and photo captions are deleted for good once they’re{' '}
            {DEPARTED_CONTENT_MAX_AGE_DAYS} days old. The account itself goes in{' '}
            {DELETION_GRACE_DAYS} days.
          </p>
          <p className="m-0">
            During those {DELETION_GRACE_DAYS} days you can still sign in, and canceling keeps the
            account — but your profile stays empty and you’d set it up again from scratch. Export
            your data first if you want a copy.
          </p>
          {failed && <FormLine>{failed}</FormLine>}
          {confirming ? (
            <Actions className="justify-between">
              <Button onClick={() => setConfirming(false)} disabled={deleteBusy}>
                Never mind
              </Button>
              <Button
                variant="danger"
                armed
                loading={deleteBusy}
                onClick={onDelete}
                data-attr="settings-delete-confirm"
              >
                <FontAwesomeIcon icon={faTrash} aria-hidden="true" />
                Yes, delete my account
              </Button>
            </Actions>
          ) : (
            <Actions>
              <Button
                variant="danger"
                onClick={() => setConfirming(true)}
                data-attr="settings-delete"
              >
                <FontAwesomeIcon icon={faTrash} aria-hidden="true" />
                Delete my account
              </Button>
            </Actions>
          )}
        </DangerBox>
      </Section>
    </>
  );
}

/** "February 12, 2027" */
function longDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function DangerBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-(--space-3_5) border border-line2 border-l-2 border-l-fg1 border-solid px-(--space-5) py-(--space-4_5) text-fg1 text-row leading-body [&_b]:text-fg">
      {children}
    </div>
  );
}
