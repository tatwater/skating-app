/**
 * "Your data export is ready" (D33 / D62) — the first template moved into React Email, and the
 * simplest: one link with an expiry.
 *
 * The default export exists for the `email dev` preview server, which renders each template file
 * with its `PreviewProps`; the named export is what the app renders.
 */

import { Heading, Link, Text } from 'react-email';
import { Layout, styles } from '../Layout';

export type DataExportReadyProps = {
  /** The signed download URL. Rendered as-is; React escapes it. */
  downloadUrl: string;
  /** How long the link works, after which the bundle is deleted from storage. */
  ttlDays: number;
};

export function DataExportReady({ downloadUrl, ttlDays }: DataExportReadyProps) {
  const days = `${ttlDays} day${ttlDays === 1 ? '' : 's'}`;
  return (
    <Layout preview="Your Gli data export is ready to download.">
      <Heading as="h2" style={styles.heading}>
        Your data export is ready
      </Heading>
      <Text style={styles.paragraph}>
        This link works for {days}, after which the bundle is deleted from our storage.
      </Text>
      <Text style={styles.paragraph}>
        <Link href={downloadUrl} style={styles.link}>
          Download your data →
        </Link>
      </Text>
    </Layout>
  );
}

DataExportReady.PreviewProps = {
  downloadUrl: 'https://example.convex.site/export/preview',
  ttlDays: 7,
} satisfies DataExportReadyProps;

export default DataExportReady;
