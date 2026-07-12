import { DOC_URLS } from '../lib/links'
import { RISK_ACK_COPY } from '../lib/riskAck'

/**
 * The blocking assumption-of-risk acknowledgment control (D45), shared by the onboarding
 * and re-ack pages so the copy, the privacy/terms links, and the accessibility semantics
 * stay identical — the web analog of mobile's `RiskAckConsent`. The whole row is a native
 * `<label>` wrapping the checkbox, so the full risk copy is the accessible name.
 */
export function RiskAckConsent({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-start gap-3 text-foreground-muted text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--primary)]"
        />
        <span>{RISK_ACK_COPY}</span>
      </label>
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
