import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCar,
  faLocationCrosshairs,
  faLocationDot,
  faPen,
} from '@fortawesome/sharp-light-svg-icons';

import { Button } from '../../kit/button';
import { Field, FieldLabel } from '../../kit/input';
import { Section } from '../../kit/section-slug';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../kit/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../kit/tooltip';
import { FormLine } from '../auth/SystemStage';
import { INK_PRIMARY } from '../styles';
import { AddressField } from './AddressField';
import type { AddressLookup, AddressSuggestion } from './geocoder';
import { Actions, Block, BlockText, OrRule, PaneHead, Row, Rows } from './SettingsParts';

export type HomeView = 'summary' | 'edit' | 'travel';
export type LocateState = 'idle' | 'locating' | 'failed';

/** "30 · 60 · 90 min" */
export function bandsLabel(bands: readonly number[]): string {
  return `${bands.join(' · ')} min`;
}

/** The days a traveling base can run to: tomorrow through four weeks out, as the picker lists them. */
export function travelDays(now: number, count = 28): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const start = new Date(now);
  start.setHours(12, 0, 0, 0);
  for (let i = 1; i <= count; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push({
      value: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    });
  }
  return out;
}

export interface HomeSectionProps {
  view: HomeView;
  hasHome: boolean;
  /** The drive-time bands the home feeds. */
  bands: readonly number[];
  /** The typed address: what's in the field, what the provider said, and what was picked. */
  address: string;
  onAddressChange: (value: string) => void;
  lookup: AddressLookup;
  chosen: AddressSuggestion | null;
  onPick: (suggestion: AddressSuggestion) => void;
  locate: LocateState;
  saving: boolean;
  /** A save the server refused. */
  failed: boolean;
  onUseLocation: () => void;
  onSave: () => void;
  onClear: () => void;
  onEdit: () => void;
  onCancel: () => void;
  /**
   * Traveling (7.19): only when the server can hold a temporary base. Absent, the section draws
   * no Traveling block at all rather than a control that can't save.
   */
  travel?: {
    days: { value: string; label: string }[];
    until: string;
    onUntilChange: (value: string) => void;
    onOpen: () => void;
    onStart: () => void;
  };
}

/**
 * Home and drive time (7.5, 7.6, 7.18, 7.19). Home is typed as an address with suggestions; "Use my
 * current location" is the second way — and the only one while no address provider is on, or once
 * the provider's limit is reached. It stays private: only the drive-time zones derived from it are
 * kept (D11).
 */
export function HomeSection(props: HomeSectionProps) {
  const { view, hasHome } = props;
  return (
    <>
      <PaneHead title="Home and drive time">
        Your home anchors the drive-time filter and nearby notifications. It stays private — no one
        else ever sees it, and your profile shows only the town you set manually.
      </PaneHead>
      {view === 'edit' || (view === 'summary' && !hasHome) ? (
        <>
          {!hasHome && (
            <Block>
              <Rows label="Home">
                <Row
                  label="Home"
                  muted
                  sub="Drive time on Latest and the nearby notifications won’t work until you set this"
                >
                  Not set
                </Row>
              </Rows>
            </Block>
          )}
          {view === 'edit' ? (
            <Section title="Change home">
              <HomeForm {...props} />
            </Section>
          ) : (
            <Block>
              <HomeForm {...props} />
            </Block>
          )}
        </>
      ) : view === 'travel' && props.travel ? (
        <>
          <HomeSummary {...props} />
          <Section title="Traveling">
            <TravelForm {...props} travel={props.travel} />
          </Section>
        </>
      ) : (
        <>
          <HomeSummary {...props} />
          {props.travel && (
            <Section title="Traveling">
              <div className="flex flex-col gap-(--space-4) border border-line2 border-solid px-(--space-5) pt-(--space-4_5) pb-(--space-5)">
                <BlockText>
                  Away from home for a while? Set a temporary base and drive time measures from
                  there instead, until the day you pick.
                </BlockText>
                <Actions>
                  <Button onClick={props.travel.onOpen} data-attr="settings-travel-open">
                    <FontAwesomeIcon icon={faLocationDot} aria-hidden="true" />
                    Set a temporary base
                  </Button>
                </Actions>
              </div>
            </Section>
          )}
        </>
      )}
    </>
  );
}

function HomeSummary({ bands, onEdit, onClear, saving }: HomeSectionProps) {
  return (
    <Block>
      <Rows label="Home">
        <Row
          label="Home"
          sub="Private — only you see it"
          action={
            <>
              <Button size="sm" onClick={onEdit} data-attr="settings-home-change">
                <FontAwesomeIcon icon={faPen} aria-hidden="true" />
                Change home
              </Button>
              <Button size="sm" onClick={onClear} disabled={saving} data-attr="settings-home-clear">
                Clear
              </Button>
            </>
          }
        >
          Set
        </Row>
        <Row label="Drive-time zones" mono>
          {bandsLabel(bands)}
        </Row>
        <Row label="Used by">
          The drive-time filter on Latest, Wanted near you, and two notifications
        </Row>
      </Rows>
    </Block>
  );
}

/** Whether a typed address can be offered at all this session. */
function addressAvailable(lookup: AddressLookup): boolean {
  return lookup.state !== 'off' && lookup.state !== 'quota' && lookup.state !== 'unknown';
}

function HomeForm(props: HomeSectionProps) {
  const typed = addressAvailable(props.lookup);
  return (
    <div className="flex flex-col gap-(--space-3_5)">
      {typed && (
        <>
          <AddressField
            label="Home address"
            hint="We work out your drive-time zones from it. Only you ever see it."
            value={props.address}
            onValueChange={props.onAddressChange}
            lookup={props.lookup}
            onPick={props.onPick}
            autoFocus={props.view === 'edit'}
          />
          <OrRule />
        </>
      )}
      {props.lookup.state === 'quota' && (
        <BlockText muted>
          Address suggestions are paused for now. Use your current location instead — from home, not
          from the lake.
        </BlockText>
      )}
      <Actions>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                onClick={props.onUseLocation}
                loading={props.locate === 'locating'}
                disabled={props.saving}
                data-attr="settings-home-locate"
              />
            }
          >
            <FontAwesomeIcon icon={faLocationCrosshairs} aria-hidden="true" />
            Use my current location
          </TooltipTrigger>
          <TooltipContent>
            Your browser asks to share your location once. Use it from home, not from the lake.
          </TooltipContent>
        </Tooltip>
      </Actions>
      {props.locate === 'failed' && (
        <FormLine>We couldn’t get your location. Check that the browser may share it.</FormLine>
      )}
      {props.failed && <FormLine>Your home wasn’t saved. Try again in a moment.</FormLine>}
      {(typed || props.view === 'edit') && (
        <Actions className="mt-(--space-3_5)">
          {typed && (
            <Button
              variant="primary"
              className={INK_PRIMARY}
              disabled={props.chosen === null}
              loading={props.saving}
              onClick={props.onSave}
              data-attr="settings-home-save"
            >
              Save home
            </Button>
          )}
          {props.view === 'edit' && <Button onClick={props.onCancel}>Cancel</Button>}
        </Actions>
      )}
    </div>
  );
}

function TravelForm(props: HomeSectionProps & { travel: NonNullable<HomeSectionProps['travel']> }) {
  const { travel } = props;
  const day = travel.days.find((d) => d.value === travel.until)?.label ?? '';
  return (
    <div className="flex flex-col gap-(--space-4) border border-line2 border-l-2 border-l-fg1 border-solid px-(--space-5) pt-(--space-4_5) pb-(--space-5)">
      <div className="flex items-center gap-(--space-2_5) font-medium text-body text-fg">
        <FontAwesomeIcon icon={faCar} aria-hidden="true" className="h-[0.9375rem] text-fg2" />
        Temporary base
      </div>
      <div className="flex items-end gap-(--space-5)">
        <div className="min-w-0 flex-1">
          <AddressField
            label="Address"
            hint="Like your home, it stays private."
            value={props.address}
            onValueChange={props.onAddressChange}
            lookup={props.lookup}
            onPick={props.onPick}
            autoFocus
          />
        </div>
        <Field className="w-[13.75rem] flex-none">
          <FieldLabel>Until</FieldLabel>
          <Select value={travel.until} onValueChange={(v) => travel.onUntilChange(String(v))}>
            <SelectTrigger aria-label="Until">
              <SelectValue>{day}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {travel.days.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <BlockText muted>
        Drive time on Latest and the nearby notifications measure from here through {day}, then your
        home takes over again.
      </BlockText>
      <Actions>
        <Button
          variant="primary"
          className={INK_PRIMARY}
          disabled={props.chosen === null}
          loading={props.saving}
          onClick={travel.onStart}
          data-attr="settings-travel-start"
        >
          Start traveling
        </Button>
        <Button onClick={props.onCancel}>Cancel</Button>
      </Actions>
    </div>
  );
}
