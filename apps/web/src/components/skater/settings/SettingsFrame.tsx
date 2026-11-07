import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRightFromBracket, faCircleInfo } from '@fortawesome/sharp-light-svg-icons';
import type { KeyboardEvent, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Avatar } from '../../kit/avatar';
import { Badge } from '../../kit/badge';
import { navLinkProps } from '../chrome';
import { type SettingsSection, visibleSections } from './sections';

export interface SettingsPerson {
  name: string;
  username: string;
  imageUrl?: string;
}

/**
 * Settings (row 7), props only: the section list on the left — who you are, the eight sections,
 * then About and Sign out — and one section's body on the right.
 *
 * **The list is links**, so a section is a URL (D242) and opens in a new tab like any link; ↑ and
 * ↓ move between them (Home and End to the ends), Tab leaves the list for the section.
 * While a deletion is pending (D62) the profile section is gone (it was cleared) and the data
 * section carries the mark that brought you here.
 */
export function SettingsFrame({
  section,
  person,
  leaving = false,
  signOutOpen = false,
  onNavigate,
  onSignOut,
  children,
}: {
  /** The section open, or `null` while the sign-out confirm holds the list's last row lit. */
  section: SettingsSection;
  person: SettingsPerson;
  leaving?: boolean;
  /** The sign-out confirm is up: its row is the lit one (7.15). */
  signOutOpen?: boolean;
  onNavigate: (href: string) => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const sections = visibleSections(leaving);
  return (
    <div
      data-slot="settings"
      className="mx-auto flex w-full max-w-[61.5rem] gap-(--space-14) px-(--space-4) pt-(--space-8) pb-(--space-14)"
    >
      <nav
        aria-label="Settings"
        className="flex w-[15.5rem] flex-none flex-col gap-[0.125rem]"
        onKeyDown={rove}
      >
        <div className="mb-(--space-3) flex items-center gap-(--space-3) border-0 border-line border-b border-solid pb-(--space-5)">
          {leaving ? (
            <span
              aria-hidden="true"
              className="size-avatar flex-none rounded-full border border-line2 border-dashed"
            />
          ) : (
            <Avatar name={person.name} src={person.imageUrl} aria-hidden="true" />
          )}
          <div className="ph-no-capture min-w-0">
            <div
              className={cn(
                'truncate font-medium text-row',
                leaving ? 'text-fg2 italic' : 'text-fg',
              )}
            >
              {person.name}
            </div>
            <div className="truncate font-(family-name:--family-mono) text-fg2 text-mono-sm">
              @{person.username}
            </div>
          </div>
        </div>
        <ul className="m-0 flex list-none flex-col gap-[0.125rem] p-0">
          {sections.map((s) => {
            const on = s.key === section && !signOutOpen;
            return (
              <li key={s.key}>
                <NavRow
                  {...navLinkProps(`/settings/${s.key}`, onNavigate)}
                  icon={<FontAwesomeIcon icon={s.icon} />}
                  current={on}
                  dataAttr={`settings-nav-${s.key}`}
                >
                  {s.label}
                  {leaving && s.key === 'data' && (
                    <Badge tone="warn" className="ml-auto">
                      Pending
                    </Badge>
                  )}
                </NavRow>
              </li>
            );
          })}
        </ul>
        <hr className="my-(--space-2_5) w-full border-0 border-line border-t border-solid" />
        <ul className="m-0 flex list-none flex-col gap-[0.125rem] p-0">
          <li>
            <NavRow
              {...navLinkProps('/about', onNavigate)}
              icon={<FontAwesomeIcon icon={faCircleInfo} />}
            >
              About and licenses
            </NavRow>
          </li>
          <li>
            <NavRow
              as="button"
              onClick={onSignOut}
              icon={<FontAwesomeIcon icon={faArrowRightFromBracket} />}
              current={signOutOpen}
              dataAttr="settings-sign-out"
            >
              Sign out
            </NavRow>
          </li>
        </ul>
      </nav>
      <section aria-label="Section" className="flex w-[42.5rem] min-w-0 flex-col gap-(--space-8)">
        {children}
      </section>
    </div>
  );
}

const ROW =
  'relative flex h-[2.375rem] w-full cursor-pointer items-center gap-(--space-3) rounded-control border-0 bg-transparent px-(--space-3) text-left text-fg1 text-row no-underline outline-none transition-[background-color,color] duration-(--duration-fast) ease-standard focus-visible:shadow-focus [&_svg]:h-[0.875rem] [&_svg]:w-[0.875rem] [&_svg]:text-fg2 lit:bg-lift-08 lit:text-fg';
const ON =
  'bg-raise text-fg before:absolute before:top-(--space-2) before:bottom-(--space-2) before:left-0 before:w-[0.125rem] before:bg-fg [&_svg]:text-fg';

function NavRow({
  as,
  href,
  onClick,
  icon,
  current = false,
  dataAttr,
  children,
}: {
  as?: 'button';
  href?: string;
  onClick: (event: never) => void;
  icon: ReactNode;
  current?: boolean;
  dataAttr?: string;
  children: ReactNode;
}) {
  const body = (
    <>
      {icon}
      {children}
    </>
  );
  if (as === 'button') {
    return (
      <button
        type="button"
        data-nav-row=""
        data-attr={dataAttr}
        aria-pressed={current ? true : undefined}
        className={cn(ROW, current && ON)}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }
  return (
    <a
      href={href}
      data-nav-row=""
      data-attr={dataAttr}
      aria-current={current ? 'page' : undefined}
      className={cn(ROW, current && ON)}
      onClick={onClick}
    >
      {body}
    </a>
  );
}

/** ↑/↓ walk the list's rows, Home/End jump to its ends; focus moves, nothing is opened. */
function rove(event: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-nav-row]')];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (at === -1) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : (at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
}
