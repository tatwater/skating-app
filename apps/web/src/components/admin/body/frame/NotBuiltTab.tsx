import { Button } from '@/components/kit/button';
import { Note } from '@/components/kit/note';

/**
 * A tab slot with no tab in it yet: it says so plainly, and links the old editor that still does the
 * work, so nothing is out of reach meanwhile (§1, lose nothing).
 */
export function NotBuiltTab({ label, oldEditorHref }: { label: string; oldEditorHref?: string }) {
  return (
    <div data-slot="body-tab-not-built" className="flex flex-col items-start gap-(--space-3_5)">
      <Note>{label} isn’t in the console yet. The old editor still has it.</Note>
      {oldEditorHref !== undefined && (
        <Button variant="link" size="sm" render={<a href={oldEditorHref} />}>
          Old editor →
        </Button>
      )}
    </div>
  );
}
