import { Button } from '@/components/kit/button';

/**
 * *Try again*, beside a read that failed: the kit's extra-small button, which re-runs the read. A
 * button in the tab order — no shortcut of its own.
 */
export function TryAgain({ onRetry }: { onRetry: () => void }) {
  return (
    <Button size="xs" data-slot="try-again" onClick={onRetry}>
      Try again
    </Button>
  );
}
