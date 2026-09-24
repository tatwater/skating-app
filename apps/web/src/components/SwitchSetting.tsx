import { Card, CardContent } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';

/**
 * One on/off setting on the Settings page: a section heading, a card with the checkbox and its
 * label, and a line of explainer under it. The D58 aggregate opt-out and the remembered put-in
 * default (Phase 04 #7) are the same control with different words — the words come from
 * `@skating/core` so the two surfaces can't describe one promise differently, and the layout comes
 * from here so a fix to one switch is a fix to both.
 *
 * Saves on flip, with no Save button (unlike the profile editor): a privacy switch should take effect
 * when you flip it, with no second step that can be abandoned half-done.
 */
export function SwitchSettingView({
  id,
  heading,
  label,
  explainer,
  checked,
  onToggle,
}: {
  /** The checkbox's DOM id — what the label points at. */
  id: string;
  heading: string;
  label: string;
  explainer: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        {heading}
      </h2>
      <Card>
        <CardContent className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <Checkbox id={id} checked={checked} onCheckedChange={(v) => onToggle(v === true)} />
            <Label htmlFor={id} className="text-foreground text-sm">
              {label}
            </Label>
          </div>
          <p className="text-foreground-muted text-xs">{explainer}</p>
        </CardContent>
      </Card>
    </section>
  );
}
