import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDeployment } from './deployment';

/** A throwaway dir standing in for `packages/convex/`, with the given `.env.local` (or none). */
function fakeConvexPackage(envLocal?: string): URL {
  const dir = mkdtempSync(join(tmpdir(), 'run-log-'));
  if (envLocal !== undefined) writeFileSync(join(dir, '.env.local'), envLocal);
  return pathToFileURL(`${dir}/`);
}

describe('resolveDeployment', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.CONVEX_DEPLOY_KEY = undefined;
    delete process.env.CONVEX_DEPLOY_KEY;
    delete process.env.CONVEX_DEPLOYMENT;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads CONVEX_DEPLOYMENT from the environment first', () => {
    process.env.CONVEX_DEPLOYMENT = 'dev:agile-bee-397';
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

  it('strips the trailing comment `convex dev` writes on the deployment line', () => {
    const dir = fakeConvexPackage(
      'CONVEX_DEPLOYMENT=dev:agile-bee-397 # team: teagan-atwater, project: skating-app\n',
    );
    expect(resolveDeployment(dir).label).toBe('dev:agile-bee-397');
  });

  it('flags a prod deployment as prod and not dev', () => {
    process.env.CONVEX_DEPLOYMENT = 'prod:diligent-guanaco-965';
    expect(resolveDeployment()).toEqual({
      label: 'prod:diligent-guanaco-965',
      isDev: false,
      isProd: true,
    });
  });

  it('treats a deploy key as non-dev — it points anywhere, so the guard fails closed', () => {
    process.env.CONVEX_DEPLOY_KEY = 'secret';
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
