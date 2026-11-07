import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEnvelope } from '@fortawesome/sharp-light-svg-icons';
import { useState } from 'react';

import { Button } from '../../kit/button';
import { Field, FieldLabel } from '../../kit/input';
import { Textarea } from '../../kit/textarea';
import { FormLine } from '../auth/SystemStage';
import { INK_PRIMARY } from '../styles';
import { Actions, Block, BlockText, PaneHead } from './SettingsParts';

export const SUPPORT_TOPICS = [
  { value: 'bug', label: 'Bug report' },
  { value: 'safety', label: 'Safety concern' },
  { value: 'account', label: 'Account / appeal' },
  { value: 'other', label: 'Something else' },
] as const;

export type SupportTopic = (typeof SUPPORT_TOPICS)[number]['value'];

export type SupportState = 'idle' | 'sending' | 'sent' | 'failed';

/**
 * Contact support (7.11, D35): a topic if you like, and the message. A suspended or banned person
 * can still write (an appeal), which is why nothing here checks standing. The words are the
 * person's: `ph-no-capture`.
 */
export function SupportSection({
  replyTo,
  state,
  onSend,
  onAnother,
}: {
  replyTo: string | null;
  state: SupportState;
  /** No topic picked sends as "Something else". */
  onSend: (topic: SupportTopic, body: string) => void;
  onAnother: () => void;
}) {
  const [topic, setTopic] = useState<SupportTopic | null>(null);
  const [body, setBody] = useState('');
  return (
    <>
      <PaneHead title="Contact support">
        A Gli moderator will read every message. For a report or comment, flagging in-context from
        the thing itself will reach a moderator faster.
      </PaneHead>
      {state === 'sent' ? (
        <Block>
          <BlockText>Thanks — we got it. We’ll follow up if we need more.</BlockText>
          <Actions>
            <Button onClick={onAnother}>Send another</Button>
          </Actions>
        </Block>
      ) : (
        <form
          className="ph-no-capture flex flex-col gap-(--space-5_5)"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim()) onSend(topic ?? 'other', body.trim());
          }}
        >
          <fieldset className="m-0 flex flex-col gap-(--space-2) border-0 p-0">
            <legend className="mb-(--space-2) flex w-full items-baseline p-0 font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
              What’s it about?
              <span className="ml-auto text-assist text-fg3 normal-case tracking-normal">
                Optional
              </span>
            </legend>
            <div className="flex flex-wrap gap-(--space-1_5)">
              {SUPPORT_TOPICS.map((t) => (
                <Button
                  key={t.value}
                  type="button"
                  size="sm"
                  aria-pressed={topic === t.value}
                  className="aria-pressed:bg-fg1 aria-pressed:text-bg aria-pressed:inset-ring-fg1"
                  onClick={() => setTopic((now) => (now === t.value ? null : t.value))}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </fieldset>
          <Field>
            <FieldLabel>Message</FieldLabel>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[10rem]"
              data-attr="settings-support-message"
            />
          </Field>
          {state === 'failed' && <FormLine>That didn’t send. Try again in a moment.</FormLine>}
          <Actions>
            <Button
              type="submit"
              variant="primary"
              className={INK_PRIMARY}
              loading={state === 'sending'}
              disabled={!body.trim()}
              data-attr="settings-support-send"
            >
              <FontAwesomeIcon icon={faEnvelope} aria-hidden="true" />
              Send
            </Button>
            {replyTo && <span className="text-assist text-fg2">Replies go to {replyTo}</span>}
          </Actions>
        </form>
      )}
    </>
  );
}
