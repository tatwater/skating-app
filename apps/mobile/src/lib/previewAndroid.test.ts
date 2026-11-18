import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/preview-android.mjs', import.meta.url));
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'preview-android-'));
  const eas = join(cwd, 'eas');
  writeFileSync(
    eas,
    `#!/bin/sh\nprintf "%s\\n" "\${GOOGLE_SERVICES_JSON##*/}" "$@"\nexit "\${STUB_EXIT:-0}"\n`,
  );
  chmodSync(eas, 0o700);
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function preview(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, '--non-interactive'], {
    cwd,
    // Only the stub EAS should be callable, never the developer's installed CLI.
    env: { NODE_ENV: 'production', PATH: cwd, ...env },
    encoding: 'utf8',
  });
}

describe('Android preview preflight', () => {
  it('uses the Firebase path from .env.local and forwards the preview flags', () => {
    writeFileSync(join(cwd, '.env'), 'GOOGLE_SERVICES_JSON=missing.json\n');
    writeFileSync(join(cwd, '.env.local'), 'GOOGLE_SERVICES_JSON="firebase fixture.json"\n');
    writeFileSync(join(cwd, 'firebase fixture.json'), '{}');

    const result = preview();
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'firebase fixture.json',
      'build',
      '--profile',
      'preview',
      '--platform',
      'android',
      '--no-wait',
      '--non-interactive',
    ]);
  });

  it('prefers a shell setting to .env.local and preserves the EAS exit code', () => {
    writeFileSync(join(cwd, '.env.local'), 'GOOGLE_SERVICES_JSON=dotenv.json\n');
    writeFileSync(join(cwd, 'dotenv.json'), '{}');
    writeFileSync(join(cwd, 'shell.json'), '{}');

    const result = preview({ GOOGLE_SERVICES_JSON: 'shell.json', STUB_EXIT: '7' });
    expect(result.status).toBe(7);
    expect(result.stdout).toMatch(/^shell\.json\n/);
  });

  it('falls back to the default file when the configured path does not exist', () => {
    writeFileSync(join(cwd, 'google-services.json'), '{}');
    const result = preview({ GOOGLE_SERVICES_JSON: 'missing.json' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^google-services\.json\n/);
  });

  it('does not launch EAS if no Firebase file exists', () => {
    const result = preview();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Android preview needs a local google-services.json');
    expect(result.stdout).toBe('');
  });
});
