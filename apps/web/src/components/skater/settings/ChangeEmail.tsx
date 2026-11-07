import type { OldEmailOutcome } from '@skating/core';
import { useState } from 'react';
import { Button } from '../../kit/button';
import { Field, FieldDescription, FieldLabel, Input } from '../../kit/input';
import { Section } from '../../kit/section-slug';
import { AuthField, NEED_INPUT } from '../auth/AuthField';
import { CODE_LENGTH, CodeInput } from '../auth/CodeInput';
import { FormLine } from '../auth/SystemStage';
import { INK_PRIMARY } from '../styles';
import { Actions, Block, BlockText } from './SettingsParts';

/**
 * Changing the email on the account (7.3): a new address, then the six-digit code Clerk sends it —
 * F's code input, the same one sign-in uses. Clerk owns the address (D26); the sequence is core's
 * `changeEmail`, and the server learns through Clerk's webhook. The address and the code live in
 * component state only, inside `ph-no-capture`.
 */
export type ChangeEmailStep = 'idle' | 'enter' | 'code' | 'done';

export interface ChangeEmailViewProps {
  step: Exclude<ChangeEmailStep, 'idle'>;
  /** Where the code went (`code`, `done`). */
  pendingEmail: string | null;
  busy: boolean;
  error: string | null;
  /** What became of the old address (`done`). */
  old: OldEmailOutcome | null;
  onSendCode: (email: string) => void;
  onResend: () => void;
  onVerify: (code: string) => void;
  onRetryRemove: () => void;
  onCancel: () => void;
}

export function ChangeEmailView(props: ChangeEmailViewProps) {
  const [email, setEmail] = useState(props.pendingEmail ?? '');
  const [code, setCode] = useState('');

  if (props.step === 'done') {
    return (
      <Section title="Change email" className="ph-no-capture">
        <Block>
          <BlockText>Your email is now {props.pendingEmail}.</BlockText>
          {props.old?.kind === 'kept_linked' && (
            <BlockText muted>
              Your old address stays on the account because it’s linked to your {props.old.provider}{' '}
              sign-in. It won’t receive notifications.
            </BlockText>
          )}
          {props.old?.kind === 'remove_failed' && (
            <FormLine>
              We couldn’t remove your old address. It’s still on your account as a second address
              and won’t receive notifications — you can try removing it again.
            </FormLine>
          )}
          <BlockText muted>Notification emails go to the new address from here on.</BlockText>
          <Actions>
            {props.old?.kind === 'remove_failed' && (
              <Button loading={props.busy} onClick={props.onRetryRemove}>
                Remove old address
              </Button>
            )}
            <Button onClick={props.onCancel} disabled={props.busy}>
              Done
            </Button>
          </Actions>
        </Block>
      </Section>
    );
  }

  const coding = props.step === 'code';
  return (
    <Section title="Change email" className="ph-no-capture">
      <form
        className="flex flex-col gap-(--space-5)"
        onSubmit={(event) => {
          event.preventDefault();
          if (coding) props.onVerify(code);
          else props.onSendCode(email);
        }}
      >
        <Field>
          <FieldLabel>New email</FieldLabel>
          <Input
            type="email"
            autoComplete="email"
            value={email}
            readOnly={coding}
            onChange={(e) => setEmail(e.target.value)}
            className={NEED_INPUT}
            aria-invalid={!coding && props.error !== null ? true : undefined}
          />
          {!coding && props.error !== null && (
            <FieldDescription role="alert" className="text-warn">
              {props.error}
            </FieldDescription>
          )}
        </Field>
        {coding && (
          <AuthField label="Verification code" need={props.error}>
            <CodeInput value={code} onValueChange={setCode} disabled={props.busy} />
            <FieldDescription>
              We sent a six-digit code to {props.pendingEmail}. It can take a minute.
            </FieldDescription>
          </AuthField>
        )}
        <Actions>
          {coding ? (
            <>
              <Button
                type="submit"
                variant="primary"
                className={INK_PRIMARY}
                loading={props.busy}
                disabled={code.length < CODE_LENGTH}
                data-attr="settings-email-verify"
              >
                Verify
              </Button>
              <Button type="button" onClick={props.onResend} disabled={props.busy}>
                Send a new code
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              variant="primary"
              className={INK_PRIMARY}
              loading={props.busy}
              disabled={email.trim().length === 0}
              data-attr="settings-email-send"
            >
              Email me a code
            </Button>
          )}
          <Button type="button" className="ml-auto" onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
        </Actions>
      </form>
      <BlockText muted>
        Once it’s verified, the new address becomes the one you sign in with, and the old one comes
        off the account.
      </BlockText>
    </Section>
  );
}
