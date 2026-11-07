import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faFileLines,
  faLifeRing,
  faLock,
  faMobile,
  faScaleBalanced,
} from '@fortawesome/sharp-light-svg-icons';
import type { CorpusCountLine } from '@skating/core';
import type { ReactNode } from 'react';

import logoBlack from '@/assets/gli-black-duotone.svg';
import logoWhite from '@/assets/gli-white-duotone.svg';
import { DOC_URLS } from '@/lib/links';
import { cn } from '@/lib/utils';

import { buttonVariants } from '../../kit/button';
import { Section } from '../../kit/section-slug';
import { navLinkProps } from '../chrome';
import { INK_PRIMARY } from '../styles';

const LINKS = [
  { href: DOC_URLS.license, label: 'AGPL-3.0 license', icon: faScaleBalanced },
  { href: DOC_URLS.licenseExceptions, label: 'App Store / Play exception', icon: faMobile },
  { href: DOC_URLS.privacy, label: 'Privacy notice', icon: faLock },
  { href: DOC_URLS.terms, label: 'Terms (interim)', icon: faFileLines },
];

/**
 * About Gli (7.16; signed out, 7.17) and the license disclosure (D43), props only. Public: signed
 * in it sits under the top bar; signed out the page is bare but for the logo and the way in. The
 * per-state counts come from the corpus (`regionStats.list`) and the block stays away until they
 * load — both numbers, always (A07b): what the map knows and what it recommends.
 */
export function AboutView({
  signedIn,
  counts,
  onNavigate,
}: {
  signedIn: boolean;
  /** `undefined` while loading; an empty list hides the table. */
  counts: CorpusCountLine[] | undefined;
  onNavigate: (href: string) => void;
}) {
  const body = (
    <div className="mx-auto flex w-full max-w-[70rem] gap-(--space-14) px-(--space-4) pt-(--space-10) pb-(--space-14) max-lg:flex-col">
      <section className="flex w-[38.75rem] max-w-full flex-none flex-col gap-(--space-8)">
        <div className="flex flex-col gap-(--space-5)">
          <span className="font-medium text-fg3 text-kick uppercase leading-none tracking-kick">
            About
          </span>
          <h1 className="m-0 font-semibold text-[2.75rem] text-fg uppercase leading-none tracking-disp">
            Gli
          </h1>
          <p className="m-0 text-pretty text-[1.1875rem] text-fg1 leading-body">
            A map-first, peer ice-reporting app for Nordic (wild) ice skating. Reports are named
            peers’ observations at a specific time and place — never a guarantee that ice is safe.
            You alone decide whether to step on the ice.
          </p>
        </div>
        {counts !== undefined && counts.length > 0 && (
          <Section title="The map">
            <p className="m-0 text-pretty text-body text-fg1 leading-body">
              Every lake we know about is on the map when you zoom in. The <em>active</em> ones —
              the lakes people actually skate and can actually reach — are the ones we recommend,
              notify about, and show first.
            </p>
            <table className="w-full border-collapse text-body">
              <thead>
                <tr className="h-[2rem] border-0 border-line border-y border-solid text-left font-medium text-fg3 text-kick uppercase tracking-kick">
                  <th className="font-medium">State</th>
                  <th className="w-[6.875rem] text-right font-medium">Known</th>
                  <th className="w-[6.875rem] text-right font-medium">Active</th>
                </tr>
              </thead>
              <tbody>
                {counts.map((line) => (
                  <tr
                    key={line.state}
                    className="h-[2.75rem] border-0 border-line border-b border-solid last:border-b-0"
                  >
                    <td className="text-fg">{line.stateName}</td>
                    <td className="text-right font-(family-name:--family-mono) text-fg1 text-row">
                      {line.known.toLocaleString('en-US')}
                    </td>
                    <td className="text-right font-(family-name:--family-mono) text-fg text-row">
                      {line.active?.toLocaleString('en-US') ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="text-assist text-fg3">
              Basemap and water data © OpenStreetMap contributors.
            </span>
          </Section>
        )}
      </section>
      <aside className="flex min-w-0 flex-1 flex-col gap-(--space-8) pt-(--space-2)">
        <Section title="License">
          <p className="m-0 text-pretty text-fg1 text-row leading-body">
            Licensed under AGPL-3.0, with an additional permission under section 7 of the GPLv3 (an
            App Store / Google Play distribution exception) so the app can ship on both stores.
          </p>
        </Section>
        <ul className="m-0 flex list-none flex-col gap-(--space-2) p-0">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  buttonVariants({ variant: 'link' }),
                  'h-[2.5rem] w-full justify-start gap-(--space-2_5) px-(--space-3_5)',
                )}
              >
                <FontAwesomeIcon icon={link.icon} aria-hidden="true" className="h-[0.8125rem]" />
                {link.label}
                <FontAwesomeIcon
                  icon={faArrowUpRightFromSquare}
                  aria-hidden="true"
                  className="ml-auto h-[0.8125rem] text-fg3"
                />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
        {signedIn && (
          <Section title="Help">
            <p className="m-0 text-fg1 text-row leading-body">
              Something wrong, or something unsafe on the map? A person reads every message.
            </p>
            <a
              {...navLinkProps('/settings/support', onNavigate)}
              className={cn(buttonVariants(), 'self-start')}
            >
              <FontAwesomeIcon icon={faLifeRing} aria-hidden="true" />
              Contact support
            </a>
          </Section>
        )}
      </aside>
    </div>
  );

  if (signedIn) return body;
  return (
    <div data-surface="skater" className="min-h-dvh bg-bg font-(family-name:--family-sans) text-fg">
      <header className="flex h-top items-center border-0 border-line border-b border-solid px-bar-x">
        <Logo />
        <span className="ml-auto flex gap-(--space-2)">
          <a {...navLinkProps('/sign-in', onNavigate)} className={buttonVariants()}>
            Sign in
          </a>
          <a
            {...navLinkProps('/sign-up', onNavigate)}
            className={cn(buttonVariants({ variant: 'primary' }), INK_PRIMARY)}
          >
            Create an account
          </a>
        </span>
      </header>
      <main>{body}</main>
    </div>
  );
}

function Logo(): ReactNode {
  return (
    <>
      <img src={logoWhite} alt="Gli" className="hidden h-[1.375rem] dark:block" />
      <img src={logoBlack} alt="Gli" className="block h-[1.375rem] dark:hidden" />
    </>
  );
}
