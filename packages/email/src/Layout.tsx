/**
 * The shell every transactional mail renders inside (D38).
 *
 * One layout, so the brand, the footer and the color choices live in exactly one place. Colors come
 * from `@skating/design`'s light theme rather than being typed here: mail clients don't reliably
 * honor dark-mode CSS, so the light theme is the one every recipient can read, and pulling it from
 * the token package means a palette change reaches the mail without anyone remembering it exists.
 *
 * Deliberately no images, no web fonts, no background images — a mail that renders the same in
 * Gmail, Apple Mail and a plain-text fallback beats one that looks better in one of them.
 */

import { light } from '@skating/design';
import type { ReactNode } from 'react';
import { Body, Container, Head, Html, Preview, Section, Text } from 'react-email';

export type LayoutProps = {
  /** The inbox-preview line; shown next to the subject in most clients, never in the body. */
  preview: string;
  children: ReactNode;
  /**
   * Rendered as the footer's last line. The digest-class types carry an unsubscribe link here
   * (D174); operator alerts and the data export carry nothing.
   */
  footer?: ReactNode;
};

export const styles = {
  body: {
    backgroundColor: light.background,
    color: light.foreground,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    margin: 0,
    padding: '24px 12px',
  },
  container: {
    backgroundColor: light.surface,
    border: `1px solid ${light.border}`,
    borderRadius: 8,
    maxWidth: 520,
    padding: '24px 28px',
  },
  wordmark: {
    color: light.foregroundMuted,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: '0.08em',
    margin: '0 0 20px',
    textTransform: 'uppercase' as const,
  },
  heading: {
    fontSize: 20,
    fontWeight: 700,
    lineHeight: '28px',
    margin: '0 0 12px',
  },
  paragraph: {
    fontSize: 15,
    lineHeight: '22px',
    margin: '0 0 12px',
  },
  link: {
    color: light.primary,
    textDecoration: 'underline',
  },
  footer: {
    color: light.foregroundMuted,
    fontSize: 12,
    lineHeight: '18px',
    margin: '24px 0 0',
  },
} as const;

export function Layout({ preview, children, footer }: LayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.wordmark}>Gli</Text>
          <Section>{children}</Section>
          <Text style={styles.footer}>
            You're receiving this because you have a Gli account.
            {footer ? <> {footer}</> : null}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
