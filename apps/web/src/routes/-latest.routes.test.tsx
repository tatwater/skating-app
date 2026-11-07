import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  page: vi.fn(),
  exceptions: [] as unknown[],
  sentry: true,
}));

vi.mock('@sentry/tanstackstart-react', () => ({
  captureException: (e: unknown) => m.exceptions.push(e),
}));
vi.mock('@/lib/env', () => ({
  isConfigured: {
    get sentry() {
      return m.sentry;
    },
  },
}));
vi.mock('../components/skater/latest/LatestPage', () => ({
  LatestPage: (props: Record<string, unknown>) => {
    m.page(props);
    return null;
  },
}));

import { LatestCrash } from '../components/skater/latest/LatestCrash';
import { latestSearchSchema } from '../components/skater/latest/latestSearch';
import { Route as LatestRoute } from './_skater.latest';
import { Route as FeedRoute, feedRedirectSearch } from './feed';

beforeEach(() => {
  vi.clearAllMocks();
  m.exceptions = [];
  m.sentry = true;
});

describe('/feed', () => {
  it('redirects to /latest, keeping an open report (D242)', () => {
    expect(feedRedirectSearch({ report: 'r1', qualityFloor: 'good' })).toEqual({ report: 'r1' });
    expect(feedRedirectSearch({ report: '' })).toEqual({});
    expect(feedRedirectSearch({ report: 4 })).toEqual({});
    const before = FeedRoute.options.beforeLoad as (ctx: { search: unknown }) => void;
    let thrown: unknown;
    try {
      before({ search: { report: 'r1' } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      options: { to: '/latest', search: { report: 'r1' }, replace: true },
    });
  });
});

describe('/latest', () => {
  it('validates its view params and hands them to the page', () => {
    expect(LatestRoute.options.validateSearch).toBe(latestSearchSchema);
    expect(latestSearchSchema.parse({ report: 'r1', view: 'map', q: ' narrows ' })).toEqual({
      report: 'r1',
      view: 'map',
      q: 'narrows',
      skater: undefined,
    });
    vi.spyOn(LatestRoute, 'useSearch').mockReturnValue({ report: 'r1' } as never);
    const Component = LatestRoute.options.component as ComponentType;
    render(<Component />);
    expect(m.page).toHaveBeenCalledWith({ search: { report: 'r1' } });
  });

  it('keeps a crash on the page: reported once, with a retry', () => {
    expect(LatestRoute.options.errorComponent).toBe(LatestCrash);
    const reset = vi.fn();
    const error = new Error('boom');
    render(<LatestCrash error={error} reset={reset} info={{ componentStack: '' }} />);
    expect(m.exceptions).toEqual([error]);
    expect(screen.getByText(/Latest couldn’t load/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalled();
  });

  it('sends nothing without a DSN', () => {
    m.sentry = false;
    render(<LatestCrash error={new Error('x')} reset={vi.fn()} info={{ componentStack: '' }} />);
    expect(m.exceptions).toEqual([]);
  });
});
