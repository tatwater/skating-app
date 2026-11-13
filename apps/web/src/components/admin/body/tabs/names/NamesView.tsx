import type { WaterBodyClass } from '@skating/core';
import { useState } from 'react';

import { Badge, Tag, TagRun } from '@/components/kit/badge';
import { Button } from '@/components/kit/button';
import { ChipInput } from '@/components/kit/chip-input';
import {
  DropdownMenu,
  DropdownMenuCaret,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { KeyValueList, KeyValueRow } from '@/components/kit/grid-list';
import { Input, InputGroup, InputGroupKbd } from '@/components/kit/input';
import { RadioGroup, RadioRow } from '@/components/kit/radio';
import { Section } from '@/components/kit/section-slug';
import { cn } from '@/lib/utils';

import {
  CATALOG_NAMES,
  CATALOG_TAGS,
  type ClassOption,
  classLabel,
  countryOf,
  litId,
  type NamesData,
  otherClasses,
  stateName,
} from './namesModel';
import { LIT_ROW, LoadingSection, litAttr, TabBody } from './tabParts';

/**
 * Body › Names (board 5.4.2), the default view: the name ladder, the aliases, the class and where
 * the body is. Everything it shows arrives as props; every control is drawn only when its handler
 * is passed — the wiring passes one only for a viewer who holds the capability, and only where the
 * server has the mutation.
 */

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export type NamesViewProps = {
  /** The tab's data; `undefined` while it loads. */
  data: NamesData | undefined;
  /** The lit item (the deep link's highlight), controlled by the frame. */
  lit?: string | null;
  /** Display this catalog spelling, or (`null`) go back to the catalogs' ranking. */
  onChooseName?: (value: string | null) => void;
  /** Name a body no catalog named, or (`null`) clear the name. */
  onCommunityName?: (name: string | null) => void;
  /** Replace the aliases. */
  onAliasesChange?: (aliases: string[]) => void;
  /** Set the class. */
  onClassChange?: (cls: WaterBodyClass) => void;
};

export function NamesView({
  data,
  lit = null,
  onChooseName,
  onCommunityName,
  onAliasesChange,
  onClassChange,
}: NamesViewProps) {
  if (data === undefined) {
    return (
      <TabBody aria-busy="true" data-slot="names-tab">
        <LoadingSection lines={3} />
        <LoadingSection lines={1} />
        <LoadingSection lines={2} />
        <LoadingSection lines={5} />
      </TabBody>
    );
  }
  return (
    <TabBody data-slot="names-tab">
      <NameSection data={data} lit={lit} onChoose={onChooseName} onCommunity={onCommunityName} />
      <Section title="Aliases" count={data.aliases.length} data-slot="aliases">
        {onAliasesChange ? (
          <ChipInput
            aria-label="Aliases"
            value={data.aliases}
            onValueChange={onAliasesChange}
            placeholder="Add a name skaters use"
          />
        ) : (
          data.aliases.length > 0 && (
            <ul className="flex flex-wrap gap-(--space-1_5)">
              {data.aliases.map((a) => (
                <li
                  key={a}
                  {...litAttr(lit, litId.alias(a))}
                  className={cn(
                    'inline-flex h-badge items-center bg-raise px-[0.6em] text-assist text-fg1',
                    LIT_ROW,
                  )}
                >
                  {a}
                </li>
              ))}
            </ul>
          )
        )}
      </Section>
      <ClassSection data={data} lit={lit} onChange={onClassChange} />
      <LocationSection data={data} />
    </TabBody>
  );
}

function NameSection({
  data,
  lit,
  onChoose,
  onCommunity,
}: {
  data: NamesData;
  lit: string | null;
  onChoose: NamesViewProps['onChooseName'];
  onCommunity: NamesViewProps['onCommunityName'];
}) {
  if (data.community) return <CommunityName data={data} onName={onCommunity} />;
  return (
    <Section title="Name" data-slot="name-ladder">
      <ol className="flex flex-col">
        {data.rungs.map((rung, i) => (
          <li
            // A rung is a catalog's place on the ladder: two catalogs may spell the name alike.
            // biome-ignore lint/suspicious/noArrayIndexKey: the ladder's order is its identity
            key={`${i}:${rung.value}`}
            data-slot="name-rung"
            {...litAttr(lit, litId.name(rung.value))}
            className={cn(
              'grid grid-cols-[1.125rem_minmax(0,1fr)_auto] items-start gap-x-(--space-2)',
              'border-0 border-b border-dotted border-line py-(--space-2) first:pt-0 last:border-b-0 last:pb-0',
              LIT_ROW,
            )}
          >
            <span className="font-(family-name:--family-mono) text-kick leading-list text-fg3">
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-(--space-1)">
              <span className="flex min-w-0 items-center gap-(--space-2) whitespace-nowrap">
                <span className="truncate text-body leading-list text-fg">{rung.value}</span>
                <TagRun>
                  {rung.sources.map((s) => (
                    <Tag key={s}>{CATALOG_TAGS[s]}</Tag>
                  ))}
                </TagRun>
                {rung.now && (
                  <Badge variant="outline" tone="lit" className="ms-(--space-1)">
                    Now
                  </Badge>
                )}
              </span>
              <span className="text-assist leading-list text-fg3">
                {CATALOG_NAMES[rung.sources[0] ?? 'user']}
              </span>
            </span>
            {onChoose && !rung.now && !sameName(rung.value, data.name) ? (
              <Button size="xs" onClick={() => onChoose(rung.value)}>
                Display this
              </Button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ol>
      {onChoose && data.overridden && (
        <Button size="xs" className="self-start" onClick={() => onChoose(null)}>
          Back to the catalogs’ ranking
        </Button>
      )}
    </Section>
  );
}

/** A body no catalog named: the community's name is typed, and the moderator's word is the source. */
function CommunityName({
  data,
  onName,
}: {
  data: NamesData;
  onName: NamesViewProps['onCommunityName'];
}) {
  const [draft, setDraft] = useState(data.name);
  const trimmed = draft.trim();
  return (
    <Section title="Name" data-slot="community-name">
      {onName ? (
        <form
          className="flex flex-col gap-(--space-2_5)"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed !== '' && trimmed !== data.name) onName(trimmed);
          }}
        >
          <InputGroup>
            <Input
              aria-label="Community name"
              value={draft}
              placeholder="What skaters call it"
              onChange={(e) => setDraft(e.target.value)}
            />
            <InputGroupKbd>⏎</InputGroupKbd>
          </InputGroup>
          <span className="text-assist leading-list text-fg3">
            No catalog names this body, so the name is the community’s
          </span>
          {data.name !== '' && (
            <Button
              type="button"
              size="xs"
              className="self-start"
              onClick={() => {
                setDraft('');
                onName(null);
              }}
            >
              Clear the name
            </Button>
          )}
        </form>
      ) : (
        <span className="text-body leading-list text-fg">
          {data.name === '' ? 'Unnamed water' : data.name}
        </span>
      )}
    </Section>
  );
}

function ClassSection({
  data,
  lit,
  onChange,
}: {
  data: NamesData;
  lit: string | null;
  onChange: NamesViewProps['onClassChange'];
}) {
  const [pick, setPick] = useState<WaterBodyClass>(data.cls);
  const [extra, setExtra] = useState<WaterBodyClass | null>(null);
  const base: ClassOption[] = data.classOptions ?? [{ cls: data.cls, sources: [] }];
  const options =
    extra !== null && !base.some((o) => o.cls === extra)
      ? [...base, { cls: extra, sources: [] }]
      : base;
  const others = otherClasses(options, data.cls);
  return (
    <Section
      title="Class"
      data-slot="class"
      end={
        onChange && others.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="xs" />}>
              Another class
              <DropdownMenuCaret />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {others.map((c) => (
                <DropdownMenuItem
                  key={c}
                  onClick={() => {
                    setExtra(c);
                    setPick(c);
                  }}
                >
                  {classLabel(c)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
    >
      <RadioGroup
        aria-label="Class"
        value={pick}
        readOnly={!onChange}
        onValueChange={(v) => setPick(v as WaterBodyClass)}
      >
        {options.map((o) => (
          <RadioRow
            key={o.cls}
            value={o.cls}
            {...litAttr(lit, litId.cls(o.cls))}
            // The board's choice row: 8 px over and under, the label 16 px past the circle.
            className={cn('gap-x-(--space-4) py-(--space-2)', LIT_ROW)}
            label={
              <span className="flex items-center gap-(--space-2_5)">
                {classLabel(o.cls)}
                {o.cls === data.cls && (
                  <Badge variant="outline" tone="lit">
                    Now
                  </Badge>
                )}
              </span>
            }
            aside={
              o.sources.length > 0 || o.note ? (
                <span className="flex items-center gap-(--space-2)">
                  <TagRun>
                    {o.sources.map((s) => (
                      <Tag key={s}>{s}</Tag>
                    ))}
                  </TagRun>
                  {o.note && <Tag className="normal-case">{o.note}</Tag>}
                </span>
              ) : undefined
            }
          />
        ))}
      </RadioGroup>
      {onChange && pick !== data.cls && (
        <Button className="self-start" onClick={() => onChange(pick)}>
          Set as {classLabel(pick)}
        </Button>
      )}
    </Section>
  );
}

function LocationSection({ data }: { data: NamesData }) {
  const { towns, county, state } = data.place;
  const country = countryOf(state);
  return (
    <Section title="Location" data-slot="location">
      <KeyValueList keyWidth="6.5rem">
        {(towns !== null || county !== null) && (
          <KeyValueRow label="Source">
            US Census Bureau<Tag className="ms-(--space-2)">TIGER</Tag>
          </KeyValueRow>
        )}
        {towns !== null && towns.length > 0 && (
          <KeyValueRow label="Towns">
            <span className="flex flex-col gap-(--space-1_5)">
              {towns.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </span>
          </KeyValueRow>
        )}
        {county !== null && <KeyValueRow label="County">{county}</KeyValueRow>}
        {state !== null && (
          <KeyValueRow label="State">
            {stateName(state)}
            <Tag className="ms-(--space-2)">{state}</Tag>
          </KeyValueRow>
        )}
        {country !== null && <KeyValueRow label="Country">{country}</KeyValueRow>}
      </KeyValueList>
    </Section>
  );
}
