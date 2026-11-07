import {
  isValidDisplayName,
  isValidUsername,
  MINIMUM_SIGNUP_AGE,
  meetsMinimumAge,
  normalizeDisplayName,
  normalizeUsername,
  parseDateOfBirth,
} from '@skating/core';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../kit/button';
import { Input, InputGroup, InputGroupIcon } from '../../kit/input';
import { AuthField, NEED_GROUP, NEED_INPUT } from './AuthField';
import {
  type OnboardingRefusal,
  suggestUsernames,
  USERNAME_RULE,
  usernameNeedsFixing,
} from './onboarding';
import { RiskAck } from './RiskAck';
import { FormLine, SystemCard, SystemCardHead } from './SystemStage';

export interface OnboardingValues {
  displayName: string;
  username: string;
  dateOfBirth: number;
}

/**
 * Finish your profile (8.5–8.7, 8.16, 8.18, 8.19): the client half of the trust boundary, given its
 * one action. Everything checked here is re-enforced by `upsertFromClerk` (D37); the checks are for
 * instant feedback and the button's state. `onSubmit` resolves to a refusal, or `null` when it went
 * through, in which case `AuthGate` moves on and this stays busy until it does.
 */
export function OnboardingForm({
  email,
  initial,
  onSubmit,
  onSignOut,
}: {
  /** Whose account this is finishing, in the foot: signed in but not in yet. */
  email: string | null;
  /** A pre-filled form, for the boards' other states. */
  initial?: { displayName?: string; username?: string; dob?: string; ack?: boolean };
  onSubmit: (values: OnboardingValues) => Promise<OnboardingRefusal | null>;
  onSignOut: () => void;
}) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [username, setUsername] = useState(initial?.username ?? '');
  const [dob, setDob] = useState(initial?.dob ?? '');
  const [ack, setAck] = useState(initial?.ack ?? false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [leftUsername, setLeftUsername] = useState(false);
  const [leftDob, setLeftDob] = useState(false);
  /** The handle the server said was taken, while it's still what's typed. */
  const [taken, setTaken] = useState<string | null>(null);
  const [refusedName, setRefusedName] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the form opens on its first field, once
  useEffect(() => {
    if (!initial) nameRef.current?.focus();
  }, []);

  const normalized = normalizeUsername(username);
  const dobMs = parseDateOfBirth(dob);
  const oldEnough = dobMs !== null && meetsMinimumAge(dobMs, Date.now());
  const isTaken = taken !== null && taken === normalized;

  const usernameNeed = isTaken
    ? `@${normalized} is taken. Pick another, or try one of these:`
    : refusedName === normalized || usernameNeedsFixing(username, leftUsername)
      ? USERNAME_RULE
      : null;
  const dobNeed =
    dobMs !== null
      ? oldEnough
        ? null
        : `You must be at least ${MINIMUM_SIGNUP_AGE} to use Gli.`
      : leftDob && dob.trim().length > 0
        ? 'Enter a valid date as YYYY-MM-DD.'
        : null;

  const ready =
    isValidDisplayName(normalizeDisplayName(displayName)) &&
    isValidUsername(normalized) &&
    !isTaken &&
    oldEnough &&
    ack;

  async function submit() {
    if (busy || !ready || dobMs === null) return;
    setBusy(true);
    setMessage(null);
    const refusal = await onSubmit({
      displayName: normalizeDisplayName(displayName),
      username: normalized,
      dateOfBirth: dobMs,
    });
    if (refusal === null) return;
    setBusy(false);
    if (refusal.kind === 'taken') {
      setTaken(normalized);
      usernameRef.current?.focus();
    } else if (refusal.kind === 'badname') {
      setRefusedName(normalized);
      usernameRef.current?.focus();
    } else {
      setMessage(refusal.message);
    }
  }

  return (
    <SystemCard
      wide
      foot={
        <>
          <span className="min-w-0 truncate">
            Signed in as <span className="text-fg1">{email ?? 'your account'}</span>
          </span>
          <Button size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        </>
      }
    >
      <SystemCardHead kicker="Your profile" title="Finish your profile">
        A few details before you start — this is how other skaters will see you.
      </SystemCardHead>
      <form
        noValidate
        className="contents"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-[1.125rem]">
          <AuthField label="Your full name">
            <Input
              ref={nameRef}
              name="name"
              autoComplete="name"
              value={displayName}
              onValueChange={setDisplayName}
              className={NEED_INPUT}
            />
          </AuthField>
          <AuthField
            label="Username"
            need={usernameNeed}
            after={
              isTaken && (
                <div className="flex flex-wrap gap-[0.375rem]">
                  {suggestUsernames(normalized, displayName).map((handle) => (
                    <Button
                      key={handle}
                      size="sm"
                      className="font-(family-name:--family-mono) font-medium normal-case tracking-micro"
                      onClick={() => {
                        setUsername(handle);
                        usernameRef.current?.focus();
                      }}
                    >
                      @{handle}
                    </Button>
                  ))}
                </div>
              )
            }
          >
            <InputGroup className={NEED_GROUP}>
              <InputGroupIcon className="font-(family-name:--family-mono) font-medium text-fg3">
                @
              </InputGroupIcon>
              <Input
                ref={usernameRef}
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onValueChange={setUsername}
                onBlur={() => setLeftUsername(true)}
              />
            </InputGroup>
          </AuthField>
          <AuthField label="Date of birth" need={dobNeed}>
            <Input
              name="bday"
              autoComplete="bday"
              placeholder="YYYY-MM-DD"
              value={dob}
              onValueChange={setDob}
              onBlur={() => setLeftDob(true)}
              className={`font-(family-name:--family-mono) font-medium text-row ${NEED_INPUT}`}
            />
          </AuthField>
        </div>
        <RiskAck checked={ack} onCheckedChange={setAck} />
        {message && <FormLine>{message}</FormLine>}
        <Button
          type="submit"
          variant="primary"
          disabled={!ready}
          loading={busy}
          className="h-[2.625rem] w-full"
        >
          Start skating
        </Button>
      </form>
    </SystemCard>
  );
}
