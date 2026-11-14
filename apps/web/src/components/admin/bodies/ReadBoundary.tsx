import { Component, type ReactNode } from 'react';

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

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
