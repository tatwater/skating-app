import { DOC_URLS } from '../lib/links'
import { RISK_ACK_COPY } from '../lib/riskAck'
import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'

/**
 * The blocking assumption-of-risk acknowledgment control (D45), shared by the onboarding
 * and re-ack pages so the copy, the privacy/terms links, and the accessibility semantics
 * stay identical — the web analog of mobile's `RiskAckConsent`. The shadcn (Base UI) `Checkbox`
 * is tied to the full risk copy via a `<Label htmlFor>`, so the copy is its accessible name and
 * clicking the text toggles it.
 */
export function RiskAckConsent({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <Checkbox
          id="risk-ack"
          checked={checked}
          onCheckedChange={() => onToggle()}
          className="mt-1"
        />
        <Label htmlFor="risk-ack" className="font-normal text-foreground-muted text-sm">
          {RISK_ACK_COPY}
        </Label>
      </div>
      <div className="flex gap-4 text-sm">
        <a
          className="text-primary hover:underline"
          href={DOC_URLS.privacy}
          target="_blank"
          rel="noreferrer"
        >
          Privacy notice
        </a>
        <a
          className="text-primary hover:underline"
          href={DOC_URLS.terms}
          target="_blank"
          rel="noreferrer"
        >
          Terms (interim)
        </a>
      </div>
    </div>
  )
}
