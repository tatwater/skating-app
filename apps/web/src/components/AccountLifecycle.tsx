import { api } from '@skating/convex/api';
import { DELETION_GRACE_DAYS, DELETION_GRACE_MS } from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

/**
 * Export + delete (D33/D62) — the two account-lifecycle controls, kept together because they're the
 * pair a person uses in one sitting: take your data with you, then leave.
 *
 * The ordering on screen is deliberate. Export comes first, and the delete copy points at it, because
 * anyone deleting an account is the person most likely to want their record — and the moment after
 * they confirm is too late to say so.
 *
 * Split container/view the way `AggregateTracksSetting` is, because the **copy is the feature here**.
 * What a person believes will happen when they press this button is the thing most worth a test: they
 * have to know their reports survive *before* confirming, not discover it afterwards.
 */
export function AccountLifecycle() {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Your data
      </h2>
      <DataExport />
      <DeleteAccount />
    </section>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ExportRow {
  exportId: string;
  status: 'building' | 'ready' | 'failed';
  requestedAt: number;
  expiresAt: number;
  sizeBytes?: number;
  omittedPhotoCount?: number;
  url: string | null;
}

/**
 * The export list. Shown here *as well as* emailed (founder call, D62) for two reasons: Resend isn't
 * provisioned until the prod cutover, so email-only would leave nothing to click today; and a
 * spam-filtered email shouldn't be the end of the road.
 */
export function DataExportView({
  exports,
  onRequest,
}: {
  exports: ExportRow[];
  onRequest: () => void;
}) {
  const building = exports.some((e) => e.status === 'building');
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="text-foreground-muted text-sm">
          Download everything we hold about you as a JSON file — your profile, reports, comments,
          hazards, recorded tracks and your photos. We'll email you a link when it's ready, and list
          it here too. Links expire after 7 days.
        </p>
        <div>
          <Button variant="outline" size="sm" onClick={onRequest} disabled={building}>
            {building ? 'Preparing your export…' : 'Export my data'}
          </Button>
        </div>
        {exports.length > 0 ? (
          <ul className="flex flex-col gap-2 border-t pt-3">
            {exports.map((e) => (
              <li key={e.exportId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-foreground-muted">{formatDate(e.requestedAt)}</span>
                {e.status === 'building' ? (
                  <span className="text-foreground-muted">Preparing…</span>
                ) : e.status === 'failed' ? (
                  <span className="text-destructive">Couldn't be prepared — try again.</span>
                ) : e.url ? (
                  <>
                    <a
                      href={e.url}
                      className="text-foreground underline underline-offset-4"
                      download
                    >
                      Download
                    </a>
                    {e.sizeBytes !== undefined ? (
                      <span className="text-foreground-muted">{formatBytes(e.sizeBytes)}</span>
                    ) : null}
                    <span className="text-foreground-muted">expires {formatDate(e.expiresAt)}</span>
                    {/* Never a silent cap: a bundle someone treats as their complete record has to
                        say when it isn't (the Phase 7 rule). */}
                    {e.omittedPhotoCount ? (
                      <span className="text-foreground-muted">
                        ({e.omittedPhotoCount} photo{e.omittedPhotoCount === 1 ? '' : 's'} too large
                        to include)
                      </span>
                    ) : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DataExport() {
  const exports = useQuery(api.dataExport.myExports, {});
  const request = useMutation(api.dataExport.requestExport);
  return (
    <DataExportView exports={(exports ?? []) as ExportRow[]} onRequest={() => void request({})} />
  );
}

/**
 * Delete, with the 30-day window (D62) stated plainly rather than buried.
 *
 * The copy names what **survives**, because "delete my account" reasonably reads as "delete everything
 * I wrote", and that isn't what happens: reports and comments stay as part of the community's ice
 * record with the author replaced by a tombstone (D33/D13). Someone deserves to know that before
 * confirming, not after — which is why it's in the body text and not a footnote.
 */
export function DeleteAccountView({
  deletionRequestedAt,
  onRequest,
  onCancel,
}: {
  deletionRequestedAt: number | undefined;
  onRequest: () => void;
  onCancel: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (deletionRequestedAt !== undefined) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3">
          <p className="text-foreground">
            Your account is scheduled for deletion on{' '}
            <strong>{formatDate(deletionRequestedAt + DELETION_GRACE_MS)}</strong>.
          </p>
          <p className="text-foreground-muted text-sm">
            Until then nothing has changed — you can keep using the app normally, and you can stop
            this at any time.
          </p>
          <div>
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel deletion
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="text-foreground-muted text-sm">
          Deleting your account removes your profile, your home location, your saved lakes and any
          recording you never published. Your <strong>reports and comments stay</strong>, with your
          name replaced — they're part of the ice record other skaters rely on. Tracks you published
          with a report stay on the lake's map the same way, no longer attached to you.
        </p>
        <p className="text-foreground-muted text-sm">
          Nothing happens for {DELETION_GRACE_DAYS} days, and you can cancel any time during them.
          Export your data first if you want a copy.
        </p>
        {confirming ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onRequest();
                setConfirming(false);
              }}
            >
              Yes, delete my account
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Never mind
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              Delete my account
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeleteAccount() {
  const profile = useQuery(api.profiles.current, {});
  const request = useMutation(api.accountDeletion.requestDeletion);
  const cancel = useMutation(api.accountDeletion.cancelDeletion);
  if (profile === undefined) return null;
  return (
    <DeleteAccountView
      deletionRequestedAt={profile?.deletionRequestedAt}
      onRequest={() => void request({})}
      onCancel={() => void cancel({})}
    />
  );
}
