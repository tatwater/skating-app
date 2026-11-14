import * as Sentry from '@sentry/tanstackstart-react';
import { Component, type ReactNode } from 'react';

import { isConfigured } from '@/lib/env';

type ReadBoundaryProps = {
  /** The place the reads below are for: a new one (another lane, body or tab) starts clean. */
  resetKey: string;
  /**
   * What stands in for what failed — its own failure note, not the console's crash screen. Handed
   * `retry`, for the note's *Try again*: it runs `onRetry` and draws the children again.
   */
  fallback: (retry: () => void) => ReactNode;
  /** Runs before the children are drawn again on *Try again* (re-runs their reads). */
  onRetry?: () => void;
  children: ReactNode;
};

/**
 * **Catches a crash below it and draws its fallback in its place** — a failed paginated read
 * (Convex's paginated hook throws a failed page into React), or anything else a page block throws.
 * The block says so in its own place, with *Try again* (the fallback's, through `retry`), instead
 * of taking the page down.
 *
 * Whatever it catches still goes to Sentry (only with a DSN), as every crash boundary's does: it
 * catches anything thrown below it, not only a read, so a bug drawn as *couldn't be shown* is
 * never a bug nobody hears about. A new `resetKey` draws the children again.
 */
class ReadBoundary extends Component<ReadBoundaryProps, { failed: boolean; resetKey: string }> {
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

  private readonly retry = () => {
    this.props.onRetry?.();
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

export { ReadBoundary, type ReadBoundaryProps };
