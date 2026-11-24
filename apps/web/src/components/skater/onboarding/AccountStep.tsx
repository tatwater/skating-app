import {
  CONSENT_REFUSAL_MESSAGES,
  composeDateOfBirth,
  dateOfBirthProblem,
  isValidDisplayName,
  isValidUsername,
  normalizeDisplayName,
  normalizeUsername,
  ONBOARDING_COPY,
} from '@skating/core';
import { useEffect, useRef, useState } from 'react';

import type { AccountDraft, AccountFields } from '@/lib/entryHold';

import { Button } from '../../kit/button';
import { Input, InputGroup, InputGroupIcon } from '../../kit/input';
import { AuthField, NEED_GROUP, NEED_INPUT } from '../auth/AuthField';
import { suggestUsernames, usernameNeedsFixing } from '../auth/onboarding';
import { DobField, type DobNeed } from './DobField';
import { ENTRY_PRIMARY, EntryHead, EntryScreen, WIDE } from './EntryScreen';
import { WEB_ONBOARDING_COPY } from './webCopy';

/** What the live check knows about a handle: free, taken, or not answered yet. */
export type UsernameAvailability = 'free' | 'taken' | 'unknown';

/**
 * The live check, as a hook the page passes in (`profiles.usernameAvailable`, debounced): handed
 * the normalized handle, or `null` while it isn't a valid one and nothing should be asked.
 */
export type UseUsernameAvailability = (username: string | null) => UsernameAvailability;

const EMPTY: AccountFields = { displayName: '', username: '', month: null, day: '', year: '' };

/**
 * **Create your account** (boards 10.1, 10.2, 11.1; D298): the full name, the `@`username with the
 * live availability check, and the date of birth. **Nothing is written here** (the governor's R1):
 * *Continue* hands the checked values on (`onContinue`), and they ride in memory to the Terms step,
 * where *Record acceptance* is the moment a profile is born.
 *
 * Every problem here is the person's to fix, so it is the amber inline line as drawn — under 18,
 * a date that isn't one, a handle that breaks the rule or is taken (with three to try). *Continue*
 * waits until the name, the handle and the date all pass; an unanswered live check doesn't hold it
 * (the acceptance checks again, and a toast sends them back if the handle went meanwhile).
 */
export function AccountStep({
  initial,
  taken: takenByServer = null,
  now,
  email,
  useAvailability,
  onContinue,
  onSignOut,
  className,
}: {
  /** The fields as left (coming back from the Terms step), or a board's. */
  initial?: AccountFields | null;
  /** A handle the acceptance refused as taken: marked until it changes. */
  taken?: string | null;
  /** The clock the 18+ gate reads (`Date.now()` in the app; pinned in a story). */
  now: number;
  email: string | null;
  useAvailability: UseUsernameAvailability;
  onContinue: (fields: AccountFields, account: AccountDraft) => void;
  onSignOut: () => void;
  className?: string;
}) {
  const copy = ONBOARDING_COPY.account;
  const [fields, setFields] = useState<AccountFields>(initial ?? EMPTY);
  const [leftUsername, setLeftUsername] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the step opens on its first empty field, once
  useEffect(() => {
    if (takenByServer !== null) usernameRef.current?.focus();
    else if (!initial) nameRef.current?.focus();
  }, []);

  const set = (patch: Partial<AccountFields>) => setFields((f) => ({ ...f, ...patch }));

  const displayName = normalizeDisplayName(fields.displayName);
  const username = normalizeUsername(fields.username);
  const validHandle = isValidUsername(username);
  const availability = useAvailability(validHandle ? username : null);
  const taken = (takenByServer !== null && takenByServer === username) || availability === 'taken';
  const problem = dateOfBirthProblem(fields, now);
  const dobNeed: DobNeed = problem === 'invalid' || problem === 'underage' ? problem : null;
  const dateOfBirth = composeDateOfBirth(fields);

  const usernameNeed = taken
    ? WEB_ONBOARDING_COPY.account.usernameTaken(username)
    : usernameNeedsFixing(fields.username, leftUsername)
      ? CONSENT_REFUSAL_MESSAGES.username_invalid
      : null;

  const ready =
    isValidDisplayName(displayName) &&
    validHandle &&
    !taken &&
    problem === null &&
    dateOfBirth !== null;

  const submit = () => {
    if (!ready || dateOfBirth === null) return;
    onContinue(fields, { displayName, username, dateOfBirth });
  };

  return (
    <form
      noValidate
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <EntryScreen
        width="account"
        className={className}
        email={email}
        onSignOut={onSignOut}
        head={
          <EntryHead kicker={copy.kicker} step={copy.step} title={copy.heading}>
            {copy.lede}
          </EntryHead>
        }
        actions={
          <Button
            type="submit"
            variant="primary"
            disabled={!ready}
            className={`${ENTRY_PRIMARY} ${WIDE}`}
            data-attr="onboarding-account-continue"
          >
            {copy.continue}
          </Button>
        }
      >
        <div className="flex flex-col gap-[1.125rem]">
          <div className="ph-no-capture" data-slot="name-field">
            <AuthField label={copy.fullName}>
              <Input
                ref={nameRef}
                name="name"
                autoComplete="name"
                value={fields.displayName}
                onValueChange={(displayName) => set({ displayName })}
                className={NEED_INPUT}
              />
            </AuthField>
          </div>
          <div className="ph-no-capture" data-slot="username-field">
            <AuthField
              label={copy.username}
              need={usernameNeed}
              after={
                taken && (
                  <div className="flex flex-wrap gap-[0.375rem]">
                    {suggestUsernames(username, fields.displayName).map((handle) => (
                      <Button
                        key={handle}
                        size="sm"
                        className="font-(family-name:--family-mono) font-medium normal-case tracking-micro"
                        onClick={() => {
                          set({ username: handle });
                          usernameRef.current?.focus();
                        }}
                      >
                        {copy.usernamePrefix}
                        {handle}
                      </Button>
                    ))}
                  </div>
                )
              }
            >
              <InputGroup className={NEED_GROUP}>
                <InputGroupIcon className="font-(family-name:--family-mono) font-medium text-fg3">
                  {copy.usernamePrefix}
                </InputGroupIcon>
                <Input
                  ref={usernameRef}
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={fields.username}
                  onValueChange={(next) => set({ username: next })}
                  onBlur={() => setLeftUsername(true)}
                />
              </InputGroup>
            </AuthField>
          </div>
          <DobField
            value={fields}
            onChange={(dob) => set({ month: dob.month, day: dob.day, year: dob.year })}
            need={dobNeed}
          />
        </div>
      </EntryScreen>
    </form>
  );
}
