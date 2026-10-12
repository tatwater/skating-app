import { Button } from '../ui/button';

/**
 * What a frozen review says when a colleague changed what it is about (D202): the sentence, and the
 * way back. The map keeps the pair as it was picked and the rows lock until the moderator goes back —
 * they choose the next pair themselves.
 */
export function ReviewClosedNotice({
  text,
  backLabel,
  onBack,
}: {
  text: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background/95 p-2 text-sm shadow-sm"
    >
      <p className="min-w-0 flex-1">{text}</p>
      <Button size="xs" variant="secondary" onClick={onBack}>
        {backLabel}
      </Button>
    </div>
  );
}
