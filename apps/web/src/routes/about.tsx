import { createFileRoute } from '@tanstack/react-router';
import { DOC_URLS } from '../lib/links';

/**
 * About + license disclosure (D43). The app is AGPL-3.0 with a GPLv3 §7 App Store / Play
 * distribution exception; both are referenced here per the Phase 0 license-hygiene
 * requirement. Final legal wording remains Q10.
 */
export const Route = createFileRoute('/about')({ component: AboutPage });

const links = [
  { href: DOC_URLS.license, label: 'AGPL-3.0 license' },
  { href: DOC_URLS.licenseExceptions, label: 'App Store / Play exception' },
  { href: DOC_URLS.privacy, label: 'Privacy notice' },
  { href: DOC_URLS.terms, label: 'Terms (interim)' },
];

function AboutPage() {
  return (
    <div className="mx-auto flex max-w-prose flex-col gap-4 py-10">
      <h1 className="font-semibold text-2xl text-foreground">Skating</h1>
      <p className="text-foreground-muted">
        A map-first, peer ice-reporting app for Nordic (wild) ice skating. Reports are named peers'
        observations at a specific time and place — never a guarantee that ice is safe. You alone
        decide whether to step on the ice.
      </p>
      <h2 className="font-semibold text-foreground text-lg">License</h2>
      <p className="text-foreground-muted">
        Licensed under AGPL-3.0, with a GPLv3 §7 additional permission (an App Store / Google Play
        distribution exception) so the app can ship on both stores.
      </p>
      <div className="flex flex-col gap-1">
        {links.map((link) => (
          <a
            key={link.href}
            className="text-primary hover:underline"
            href={link.href}
            target="_blank"
            rel="noreferrer"
          >
            {link.label}
          </a>
        ))}
      </div>
    </div>
  );
}
