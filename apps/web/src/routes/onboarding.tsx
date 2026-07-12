import { api } from '@skating/convex/api'
import {
  isValidDisplayName,
  isValidUsername,
  MINIMUM_SIGNUP_AGE,
  meetsMinimumAge,
  normalizeDisplayName,
  normalizeUsername,
  parseDateOfBirth,
} from '@skating/core'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { type FormEvent, useState } from 'react'
import { AuthCard } from '../components/AuthCard'
import { RiskAckConsent } from '../components/RiskAckConsent'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { RISK_ACK_VERSION } from '../lib/riskAck'

/**
 * Profile provisioning (D26). Reached only when the user is Clerk-authenticated but has no
 * Convex `profiles` row yet (see `AuthGate`). This is the client half of the trust boundary:
 * it collects the profile fields and the blocking Phase 0 gates — the 16+ age gate (D41) and
 * the assumption-of-risk acknowledgment (D45) — then calls `upsertFromClerk`, which
 * *re-enforces* all of it server-side (D37). DOB + ack go straight to the enforced mutation,
 * never staged in Clerk `unsafeMetadata`. On success the reactive `profiles.current` query
 * flips and the `AuthGate` routes to the app.
 */
export const Route = createFileRoute('/onboarding')({ component: OnboardingPage })

function OnboardingPage() {
  const upsertFromClerk = useMutation(api.profiles.upsertFromClerk)

  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [dob, setDob] = useState('')
  const [ack, setAck] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const dobMs = parseDateOfBirth(dob)
  const oldEnough = dobMs !== null && meetsMinimumAge(dobMs, Date.now())
  const dobTouched = dob.trim().length > 0

  const normalizedUsername = normalizeUsername(username)
  const usernameOk = isValidUsername(normalizedUsername)
  const usernameTouched = username.trim().length > 0
  const nameOk = isValidDisplayName(normalizeDisplayName(displayName))

  const canSubmit = !busy && nameOk && usernameOk && oldEnough && ack

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSubmit || dobMs === null) return
    setBusy(true)
    setError(null)
    try {
      await upsertFromClerk({
        displayName: normalizeDisplayName(displayName),
        username: normalizedUsername,
        dateOfBirth: dobMs,
        riskAckVersion: RISK_ACK_VERSION,
        // The acceptance time is stamped server-side (trust boundary, D37) — not sent.
      })
      // Success: no navigation — the AuthGate reacts to the now-provisioned profile.
    } catch (err) {
      // ConvexErrors carry a user-safe message in `.data` (e.g. "Username is already taken");
      // anything else is redacted, so fall back to a generic line.
      setError(
        err instanceof ConvexError
          ? String(err.data)
          : err instanceof Error
            ? err.message
            : 'Could not finish setting up your profile',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard title="Finish your profile">
      <p className="text-foreground-muted text-sm">
        A few details before you start — this is how other skaters will see you.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="displayName">Display name</Label>
          <Input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          {usernameTouched && !usernameOk ? (
            <p className="text-danger text-sm">
              3–30 characters: letters, numbers, or underscores (no leading or trailing _).
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="dob">Date of birth</Label>
          <Input
            id="dob"
            placeholder="YYYY-MM-DD"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
          />
          {dobTouched && dobMs === null ? (
            <p className="text-danger text-sm">Enter a valid date as YYYY-MM-DD.</p>
          ) : dobTouched && !oldEnough ? (
            <p className="text-danger text-sm">
              You must be at least {MINIMUM_SIGNUP_AGE} to use Skating.
            </p>
          ) : null}
        </div>

        <RiskAckConsent checked={ack} onToggle={() => setAck((v) => !v)} />

        {error ? <p className="text-danger text-sm">{error}</p> : null}

        <Button type="submit" disabled={!canSubmit}>
          {busy ? 'Setting up…' : 'Start skating'}
        </Button>
      </form>
    </AuthCard>
  )
}
