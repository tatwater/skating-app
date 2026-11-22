import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { FactList } from './fact-list';

test('a fact list is a description list, one term per row, keyed by label or key', () => {
  render(
    <FactList
      rows={[
        { label: 'Status', value: 'Active' },
        { label: 'Status', value: 'Again', key: 'second' },
      ]}
    />,
  );
  expect(screen.getAllByRole('term').map((t) => t.textContent)).toEqual(['Status', 'Status']);
  expect(screen.getAllByRole('definition').map((d) => d.textContent)).toEqual(['Active', 'Again']);
});
