import * as Sentry from '@sentry/tanstackstart-react';
import { Component, type ReactNode } from 'react';

import { isConfigured } from '@/lib/env';

type ReadBoundaryProps = {
  /** The place the read is for: a new one (another lane, a search, a filter) tries again. */
  resetKey: string;
  /** What stands in for the failed read: its own error state, not the console's crash screen. */
  fallback: ReactNode;
  children: ReactNode;
};

/**
 * Catches a failed read below it and draws `fallback` in its place. Convex's paginated hook throws a
 * failed page into React; this is where the Bodies list takes it back and says so in the list.
 *
 * Whatever it catches still goes to Sentry (only with a DSN), as every crash boundary's does: it
 * catches anything thrown below it, not only a read, so a bug drawn as *Couldn't read this list* is
 * never a bug nobody hears about.
 */
export class ReadBoundary extends Component<
  ReadBoundaryProps,
  { failed: boolean; resetKey: string }
> {
  constructor(props: ReadBoundaryProps) {
    super(props);
    this.state = { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: ReadBoundaryProps,
    state: { failed: boolean; resetKey: string },
  ): { failed: false; resetKey: string } | null {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  override componentDidCatch(error: unknown): void {
    if (isConfigured.sentry) Sentry.captureException(error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
