/**
 * Render a template to the pair the Resend transport sends: HTML plus a plain-text alternative.
 *
 * Both come from the same tree, so the text version can't drift from the HTML the way two
 * hand-written strings did in `lib/resend.ts`'s callers. `render` is async in React 19 (it streams
 * under the hood), which is why this is a promise rather than a string.
 */

import { render } from '@react-email/render';
import type { ReactElement } from 'react';

export type RenderedEmail = {
  html: string;
  text: string;
};

export async function renderEmail(element: ReactElement): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}
