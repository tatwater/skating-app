import { DOC_URLS } from '../../../lib/links';
import { RISK_ACK_COPY } from '../../../lib/riskAck';
import { CheckboxRow } from '../../kit/checkbox';
import { ChipLink } from './ChipLink';

/**
 * The blocking assumption-of-risk acknowledgment (D45), for onboarding and reack: the copy is legal
 * text from `lib/riskAck`, never retyped here. The whole row toggles the box and the copy is its
 * accessible name; the two documents sit outside the row, so opening one never ticks it. A panel, so
 * square.
 */
export function RiskAck({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-[0.875rem] border border-line border-solid bg-panel p-4">
      <CheckboxRow
        checked={checked}
        onCheckedChange={onCheckedChange}
        label={RISK_ACK_COPY}
        className="text-[0.84375rem] text-fg1 leading-[1.55] has-data-checked:text-fg1"
      />
      <div className="flex flex-wrap gap-2 pl-[1.75rem]">
        <ChipLink external link={<a href={DOC_URLS.privacy} target="_blank" rel="noreferrer" />}>
          Privacy notice
        </ChipLink>
        <ChipLink external link={<a href={DOC_URLS.terms} target="_blank" rel="noreferrer" />}>
          Terms (interim)
        </ChipLink>
      </div>
    </div>
  );
}
