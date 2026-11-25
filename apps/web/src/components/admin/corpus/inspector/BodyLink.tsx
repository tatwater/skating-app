import type { ReactElement } from 'react';

import { Button } from '@/components/kit/button';

import { OPEN_IN_BODY } from '../words/corpusWords';

/** The Body console's path for a body, the id escaped as every other link to it is. */
export const bodyPath = (id: string) => `/admin/body/${encodeURIComponent(id)}`;

/**
 * **The pane head's *Open in Body →*** — every Corpus task is on a body, and its console holds the
 * record. A router link from the inspector's context (`linkFor`); a plain anchor where none is given
 * (a handler's story). Handlers put it in `InspectorHeadEnd`.
 */
export function BodyLink({
  bodyId,
  linkFor,
}: {
  bodyId: string;
  linkFor?: ((path: string) => ReactElement) | undefined;
}) {
  const path = bodyPath(bodyId);
  return (
    <Button
      variant="link"
      size="xs"
      data-slot="corpus-open-in-body"
      data-to={path}
      nativeButton={false}
      // biome-ignore lint/a11y/useAnchorContent: the link chip renders its label into it
      render={linkFor?.(path) ?? <a href={path} />}
    >
      {OPEN_IN_BODY}
    </Button>
  );
}
