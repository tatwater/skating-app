import { allReferenceLinks, type ReferenceLinkBody } from '@skating/core';

/**
 * The lake drawer's reference-link list (N6c Workstream B).
 *
 * Every link is derived from the row at render time (P2/D71) except the operator-entered ones, so
 * this component takes a body rather than fetching anything — there is no query behind it and no
 * loading state to render.
 *
 * **Renders nothing when there is nothing to link to**, matching the rule the caption and the
 * bathymetry credit already follow in this drawer. A heading over an empty list is worse than no
 * heading, because it reads as a feature that broke rather than one that had no input.
 *
 * Plain `target="_blank"` on web, per D76: the in-app browser rule is a *mobile* rule, and a new tab
 * is what a desktop user expects. Mobile's `openBrowserAsync` path lives in the mobile component.
 */
export function ReferenceLinks({ body }: { body: ReferenceLinkBody | null | undefined }) {
  const links = allReferenceLinks(body);
  if (links.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Elsewhere
      </h3>
      <ul className="flex flex-col gap-2">
        {links.map((link) => (
          <li key={link.id}>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground text-sm underline underline-offset-4"
            >
              {link.label}
            </a>
            {/* The note is what stops "VTNordicskating" reading as a typo to anyone who isn't already
                in it. Absent on links whose destination speaks for itself. */}
            {link.note ? <p className="text-foreground-muted text-xs">{link.note}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
