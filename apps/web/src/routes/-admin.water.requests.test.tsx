import { describe, expect, it, vi } from 'vitest';

// The `-` prefix keeps this file out of the generated route tree (`routeFileIgnorePrefix`).

vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => (options: unknown) => ({ options }),
}));

const { Route } = await import('./admin.water.requests');
const beforeLoad = (Route as unknown as { options: { beforeLoad: () => void } }).options.beforeLoad;

describe('the old requests page', () => {
  it('redirects to the Inbox’s Requests lane, replacing the history entry', () => {
    let thrown: unknown;
    try {
      beforeLoad();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      options: { to: '/admin/inbox', search: { lane: 'requests' }, replace: true },
    });
  });
});
