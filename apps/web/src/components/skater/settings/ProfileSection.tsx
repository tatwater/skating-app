import { BIO_MAX_LENGTH, TOWN_LABEL_MAX_LENGTH } from '@skating/core';

import { Field, FieldDescription, FieldLabel, Input, InputGroup } from '../../kit/input';
import { Textarea } from '../../kit/textarea';
import { Block, PaneHead, ToggleGroupRows, ToggleRow } from './SettingsParts';
import { useAutosave } from './useAutosave';

export interface ProfileSectionProps {
  town: string;
  bio: string;
  isPublic: boolean;
  /** Under 18: the profile stays private (D41), so the switch is shown off and can't move. */
  canGoPublic: boolean;
  onSaveTown: (town: string) => Promise<unknown>;
  onSaveBio: (bio: string) => Promise<unknown>;
  onPublicChange: (isPublic: boolean) => void;
}

const STATUS_WORD = { typing: 'Typing', saving: 'Saving', saved: 'Saved', failed: 'Not saved' };

/**
 * Your profile (7.4): what other skaters see. Every field saves itself as you go — the town and bio
 * when you pause, the switch when you flip it — so there is no Save button to forget.
 */
export function ProfileSection({
  town,
  bio,
  isPublic,
  canGoPublic,
  onSaveTown,
  onSaveBio,
  onPublicChange,
}: ProfileSectionProps) {
  const townField = useAutosave(town, onSaveTown);
  const bioField = useAutosave(bio, onSaveBio);
  return (
    <>
      <PaneHead title="Your profile">
        What other skaters see on your profile. Your reports are public either way.
      </PaneHead>
      <Block className="ph-no-capture gap-(--space-5)">
        <Field>
          <FieldLabel>Town</FieldLabel>
          <InputGroup status={townField.status}>
            <Input
              value={townField.value}
              maxLength={TOWN_LABEL_MAX_LENGTH}
              placeholder="e.g. Norwich, VT"
              data-attr="settings-town"
              onChange={(e) => townField.setValue(e.target.value)}
              onBlur={townField.flush}
            />
          </InputGroup>
        </Field>
        <Field>
          <FieldLabel>Bio</FieldLabel>
          <Textarea
            value={bioField.value}
            maxLength={BIO_MAX_LENGTH}
            data-attr="settings-bio"
            onChange={(e) => bioField.setValue(e.target.value)}
            onBlur={bioField.flush}
          />
          <FieldDescription className="flex">
            <span>A short blurb — shown only on a public profile.</span>
            <span
              aria-live="polite"
              data-status={bioField.status}
              className="ml-auto font-(family-name:--family-mono) text-mono-sm text-fg3 data-[status=failed]:text-bad data-[status=saved]:text-fg2"
            >
              {STATUS_WORD[bioField.status]}
            </span>
          </FieldDescription>
        </Field>
      </Block>
      <Block>
        <ToggleGroupRows>
          <ToggleRow
            label="Public profile"
            explainer={
              canGoPublic
                ? 'A public profile is searchable and shows your town, bio, and report history. Private shows only your name and photo.'
                : 'Under-18 profiles stay private until you turn 18. Your reports are still public and help the community.'
            }
            checked={canGoPublic && isPublic}
            disabled={!canGoPublic}
            onCheckedChange={onPublicChange}
            dataAttr="settings-public-profile"
          />
        </ToggleGroupRows>
      </Block>
    </>
  );
}
