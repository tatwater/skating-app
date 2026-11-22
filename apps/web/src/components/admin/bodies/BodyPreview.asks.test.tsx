import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';

import { BodyPreview } from './BodyPreview';
import { NOW, PREVIEW_MASCOMA } from './bodiesFixtures';

/**
 * The preview's asks (B01-5c): an ask the Inbox decides — a request — opens its own Inbox item; a
 * place name (a corpus task) and an intake reason stay text.
 */

beforeAll(() => {
  Element.prototype.animate ??= (() => ({
    cancel: () => {},
    finished: Promise.resolve(),
  })) as never;
});

const asks = () => screen.getByRole('region', { name: 'Asked of this body' });

describe('the preview’s asks', () => {
  it('links a request to its Inbox item, through the route’s link', () => {
    render(
      <BodyPreview
        data={PREVIEW_MASCOMA}
        now={NOW}
        askLink={(item) => <a href={`/admin/inbox?item=${encodeURIComponent(item)}`}>x</a>}
      />,
    );
    const link = within(asks()).getByRole('link', { name: '“Shaker cove”' });
    expect(link).toHaveAttribute('href', '/admin/inbox?item=request%3Aa1');
    // The rest are no Inbox item's: text, never a link.
    expect(within(asks()).getAllByRole('link')).toHaveLength(1);
    expect(within(asks()).getByText('“the Narrows”').closest('a')).toBeNull();
  });

  it('draws every ask as text with no link given (a story)', () => {
    render(<BodyPreview data={PREVIEW_MASCOMA} now={NOW} />);
    expect(within(asks()).queryAllByRole('link')).toHaveLength(0);
    expect(within(asks()).getByText('“Shaker cove”')).toBeInTheDocument();
  });
});
