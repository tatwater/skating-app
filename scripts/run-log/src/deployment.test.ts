import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDeployment } from './deployment';

vi.mock('node:fs', { spy: true });

const fixtureDirectories: string[] = [];

/** A throwaway dir standing in for `packages/convex/`, with the given `.env.local` (or none). */
function fakeConvexPackage(envLocal?: string): URL {
  const dir = mkdtempSync(join(tmpdir(), 'run-log-'));
  fixtureDirectories.push(dir);
  if (envLocal !== undefined) writeFileSync(join(dir, '.env.local'), envLocal);
  return pathToFileURL(`${dir}/`);
}

describe('resolveDeployment', () => {
  beforeEach(() => {
    vi.stubEnv('CONVEX_DEPLOY_KEY', undefined);
    vi.stubEnv('CONVEX_DEPLOYMENT', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true });
  });

  it('reads CONVEX_DEPLOYMENT from the environment first', () => {
    vi.stubEnv('CONVEX_DEPLOYMENT', 'dev:agile-bee-397');
    expect(resolveDeployment(fakeConvexPackage('CONVEX_DEPLOYMENT=prod:other'))).toEqual({
      label: 'dev:agile-bee-397',
      isDev: true,
      isProd: false,
    });
  });

  it('falls back to the convex package .env.local', () => {
    const dir = fakeConvexPackage('CONVEX_URL=https://x\nCONVEX_DEPLOYMENT=dev:agile-bee-397\n');
    expect(resolveDeployment(dir).label).toBe('dev:agile-bee-397');
  });

  it('looks in the Convex package, not the calling script directory, by default', () => {
    vi.mocked(readFileSync).mockReturnValueOnce('CONVEX_DEPLOYMENT=dev:fixture\n');
    expect(resolveDeployment().label).toBe('dev:fixture');
    expect(readFileSync).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: expect.stringMatching(/\/packages\/convex\/\.env\.local$/),
      }),
      'utf8',
    );
  });

  it('strips the trailing comment `convex dev` writes on the deployment line', () => {
    const dir = fakeConvexPackage(
      'CONVEX_DEPLOYMENT=dev:agile-bee-397 # team: teagan-atwater, project: skating-app\n',
    );
    expect(resolveDeployment(dir).label).toBe('dev:agile-bee-397');
  });

  it('flags a prod deployment as prod and not dev', () => {
    vi.stubEnv('CONVEX_DEPLOYMENT', 'prod:diligent-guanaco-965');
    expect(resolveDeployment()).toEqual({
      label: 'prod:diligent-guanaco-965',
      isDev: false,
      isProd: true,
    });
  });

  it('treats a deploy key as non-dev — it points anywhere, so the guard fails closed', () => {
    vi.stubEnv('CONVEX_DEPLOY_KEY', 'fixture-key');
    const target = resolveDeployment(fakeConvexPackage('CONVEX_DEPLOYMENT=dev:agile-bee-397'));
    expect(target.isDev).toBe(false);
    expect(target.label).toContain('target unknown');
  });

  it('treats an unreadable .env.local as unknown, which is also non-dev', () => {
    expect(resolveDeployment(fakeConvexPackage())).toEqual({
      label: 'unknown',
      isDev: false,
      isProd: false,
    });
  });

  it('treats an .env.local with no deployment line as unknown', () => {
    expect(resolveDeployment(fakeConvexPackage('CONVEX_URL=https://x\n')).label).toBe('unknown');
  });
});
