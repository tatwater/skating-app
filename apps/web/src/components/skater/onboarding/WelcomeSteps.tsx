import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCamera, faLocationCrosshairs } from '@fortawesome/sharp-light-svg-icons';
import { BIO_MAX_LENGTH, ONBOARDING_COPY, TOWN_LABEL_MAX_LENGTH } from '@skating/core';
import { type ReactNode, useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '../../kit/button';
import { Field, FieldDescription, FieldLabel, Input } from '../../kit/input';
import { Textarea } from '../../kit/textarea';
import { FormLine } from '../auth/SystemStage';
import { AddressField } from '../settings/AddressField';
import type { AddressLookup, AddressSuggestion } from '../settings/geocoder';
import type { LocateState } from '../settings/HomeSection';
import { OrRule, ToggleRow } from '../settings/SettingsParts';
import { ENTRY_PRIMARY, EntryHead, EntryScreen, WIDE } from './EntryScreen';

/** The two buttons at a welcome step's foot: the primary takes two parts of the row, Skip one. */
function TwoActions({ primary, skip }: { primary: ReactNode; skip: ReactNode }) {
  return (
    <div className="flex gap-2 [&>*]:h-[2.625rem] @max-[48rem]/entry:[&>*]:h-[2.875rem]">
      <div className="flex flex-[2]">{primary}</div>
      <div className="flex flex-1">{skip}</div>
    </div>
  );
}

/** Whether a typed address can be offered at all this session (Settings' rule). */
function addressAvailable(lookup: AddressLookup): boolean {
  return lookup.state !== 'off' && lookup.state !== 'quota' && lookup.state !== 'unknown';
}

/**
 * **Where are you based?** (boards 10.10, 10.11, 11.10, 11.11): Settings' own address field, with
 * the map provider's suggestions as you type, or *Use my current location*. Private: only the
 * drive-time zones it anchors are ever used (D11), and the typed words are `ph-no-capture` (the
 * field's own). *Save and continue* waits for a picked suggestion; *Skip for now* only moves on.
 * While the suggestion list is open, "or" and *Use my current location* step aside for it (board
 * 10.10), as on the phone.
 */
export function HomeStep({
  address,
  onAddressChange,
  lookup,
  chosen,
  onPick,
  locate,
  saving,
  skipping,
  email,
  onUseLocation,
  onSave,
  onSkip,
  onSignOut,
  className,
}: {
  address: string;
  onAddressChange: (value: string) => void;
  lookup: AddressLookup;
  chosen: AddressSuggestion | null;
  onPick: (suggestion: AddressSuggestion) => void;
  locate: LocateState;
  saving: boolean;
  skipping: boolean;
  email: string | null;
  onUseLocation: () => void;
  onSave: () => void;
  onSkip: () => void;
  onSignOut: () => void;
  className?: string;
}) {
  const copy = ONBOARDING_COPY.home;
  const typed = addressAvailable(lookup);
  const busy = saving || skipping;
  const [listOpen, setListOpen] = useState(false);
  const listShown = typed && listOpen;
  return (
    <EntryScreen
      width="home"
      className={className}
      email={email}
      onSignOut={onSignOut}
      head={
        <EntryHead kicker={copy.kicker} step={copy.step} title={copy.heading}>
          {copy.lede}
        </EntryHead>
      }
      actions={
        <TwoActions
          primary={
            <Button
              variant="primary"
              className={cn(ENTRY_PRIMARY, 'h-full w-full')}
              disabled={chosen === null || skipping}
              loading={saving && locate !== 'locating'}
              onClick={onSave}
              data-attr="welcome-home-save"
            >
              {copy.save}
            </Button>
          }
          skip={
            <Button
              className="h-full w-full"
              disabled={saving}
              loading={skipping}
              onClick={onSkip}
              data-attr="welcome-home-skip"
            >
              {copy.skip}
            </Button>
          }
        />
      }
    >
      {typed && (
        <AddressField
          label={copy.address}
          hint={copy.addressHint}
          value={address}
          onValueChange={onAddressChange}
          lookup={lookup}
          onPick={onPick}
          onOpenChange={setListOpen}
          autoFocus
        />
      )}
      {lookup.state === 'quota' && (
        <p className="m-0 text-assist text-fg3">{copy.suggestionsOff}</p>
      )}
      {!listShown && (
        <>
          {typed && <OrRule />}
          <Button
            className={WIDE}
            onClick={onUseLocation}
            loading={locate === 'locating'}
            disabled={busy && locate !== 'locating'}
            data-attr="welcome-home-locate"
          >
            <FontAwesomeIcon icon={faLocationCrosshairs} aria-hidden="true" />
            {copy.useLocation}
          </Button>
          {locate === 'failed' && <FormLine>{copy.locationFailed}</FormLine>}
        </>
      )}
    </EntryScreen>
  );
}

/** What the Profile step holds before *Open the map* saves it. */
export interface ProfileDraft {
  bio: string;
  town: string;
  isPublic: boolean;
  showTown: boolean;
}

/**
 * **Complete your profile** (boards 10.12, 11.12): the photo (Clerk's, as in Settings), Bio, Town
 * (prefilled from the picked address's town), *Public profile* on and *Show my town* on — every new
 * account is an adult, and both default on (D298). All optional. *Show my town* stores no setting
 * of its own: on, the town is saved as the profile's town; off, it isn't (§9.15). *Open the map*
 * saves what changed; *Skip* only moves on.
 */
export function ProfileStep({
  photo,
  draft,
  onDraftChange,
  saving,
  skipping,
  email,
  onDone,
  onSkip,
  onSignOut,
  className,
}: {
  /** The photo control (`ProfilePhoto` with the step's words). */
  photo: ReactNode;
  draft: ProfileDraft;
  onDraftChange: (next: ProfileDraft) => void;
  saving: boolean;
  skipping: boolean;
  email: string | null;
  onDone: () => void;
  onSkip: () => void;
  onSignOut: () => void;
  className?: string;
}) {
  const copy = ONBOARDING_COPY.profile;
  const set = (patch: Partial<ProfileDraft>) => onDraftChange({ ...draft, ...patch });
  return (
    <EntryScreen
      width="profile"
      className={className}
      email={email}
      onSignOut={onSignOut}
      head={
        <EntryHead kicker={copy.kicker} step={copy.step} title={copy.heading}>
          {copy.lede}
        </EntryHead>
      }
      actions={
        <TwoActions
          primary={
            <Button
              variant="primary"
              className={cn(ENTRY_PRIMARY, 'h-full w-full')}
              disabled={skipping}
              loading={saving}
              onClick={onDone}
              data-attr="welcome-profile-done"
            >
              {copy.done}
            </Button>
          }
          skip={
            <Button
              className="h-full w-full"
              disabled={saving}
              loading={skipping}
              onClick={onSkip}
              data-attr="welcome-profile-skip"
            >
              {copy.skip}
            </Button>
          }
        />
      }
    >
      <div className="ph-no-capture flex flex-col gap-5">
        {photo}
        <Field>
          <FieldLabel>{copy.bio}</FieldLabel>
          <Textarea
            variant="underline"
            rows={1}
            value={draft.bio}
            maxLength={BIO_MAX_LENGTH}
            className="field-sizing-content resize-none"
            onChange={(e) => set({ bio: e.target.value })}
            data-attr="welcome-bio"
          />
        </Field>
        <Field>
          <FieldLabel>{copy.town}</FieldLabel>
          <Input
            value={draft.town}
            maxLength={TOWN_LABEL_MAX_LENGTH}
            onValueChange={(town) => set({ town })}
            data-attr="welcome-town"
          />
          <FieldDescription>{copy.townHint}</FieldDescription>
        </Field>
      </div>
      <div className="flex flex-col border-0 border-line border-t border-solid [&>[data-slot=toggle-row]:last-child]:border-b-0 [&>[data-slot=toggle-row]:last-child]:pb-0">
        <ToggleRow
          label={copy.publicProfile}
          explainer={copy.publicProfileHint}
          checked={draft.isPublic}
          onCheckedChange={(isPublic) => set({ isPublic })}
          dataAttr="welcome-public-profile"
        />
        <ToggleRow
          label={copy.showTown}
          explainer={copy.showTownHint}
          checked={draft.showTown}
          onCheckedChange={(showTown) => set({ showTown })}
          dataAttr="welcome-show-town"
        />
      </div>
    </EntryScreen>
  );
}

/** The photo button's face on the Profile step: the camera, then the words. */
export function AddPhotoLabel() {
  return (
    <>
      <FontAwesomeIcon icon={faCamera} aria-hidden="true" />
      {ONBOARDING_COPY.profile.addPhoto}
    </>
  );
}
