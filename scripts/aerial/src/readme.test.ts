/**
 * **The runbook against the code** (PR #188's ninth review). The README told the operator to delete
 * the build prefix once verify passed — which took the build manifest and the assembly record a
 * re-run of assemble and verify read. Every command, flag, variable and key path the README names is
 * held here to what the code actually takes and produces, so the next drift fails a test instead of
 * a campaign. (The README is this package's own file, so Turbo's hash sees it.)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@skating/core';
import { describe, expect, test } from 'vitest';
import { lockDir, lockPath } from './campaignLock';
import {
  archiveKey,
  buildManifestKey,
  buildPrefix,
  indexKey,
  manifestKey,
  publishPrefix,
} from './keys';
import type { StageRefusal } from './refusals';
import { runAssembleStage } from './stage/assembleStage';
import { parseFoliageArgs } from './stage/foliageRun';
import { doneRecord, FakeWorld, fixtureManifest } from './stageHarness';
import { parseStageArgs } from './stages';

const PKG = join(import.meta.dirname, '..');
const README = readFileSync(join(PKG, 'README.md'), 'utf8');
const shipped = (file: string) => readFileSync(join(PKG, file), 'utf8');

/** The README's text with line breaks and `\` continuations folded, as a shell would read it. */
const FOLDED = README.replace(/\\\n\s*/g, ' ').replace(/\s*\n\s*/g, ' ');

/** A placeholder's stand-in, so a command can be parsed. */
function filled(word: string): string {
  return word
    .replaceAll('<naip-pilot-…>', 'naip-pilot-20261212')
    .replaceAll('<campaign>', 'naip-20261212')
    .replaceAll('<YYYYMMDD>', '20261212')
    .replaceAll('<name>', 'champlain-nhma-me-ny')
    .replaceAll('<file>', 'cells.txt')
    .replaceAll('<key>', 'dev/naip/naip-summer-20261101.pmtiles')
    .replaceAll('<day>', '2027-08-11');
}

describe('the README’s commands', () => {
  /**
   * Every `run-aerial.sh` command it gives, up to the first word that isn't the campaign, a flag or
   * a flag's value (a `>`, a `;`, a closing backtick). The usage synopsis (`[--stage …]`) and the
   * "…" placeholder are not commands.
   */
  const commands = [...filled(FOLDED).matchAll(/run-aerial\.sh ([^`;>|]*)/g)]
    .map((m) => (m[1] as string).trim().split(/\s+/))
    .filter((words) => words.length > 0 && !words.some((w) => w.startsWith('[') || w === '…'))
    .map((words) => {
      const argv: string[] = [];
      for (const w of words) {
        if (argv.length > 0 && !w.startsWith('--') && !argv.at(-1)?.startsWith('--')) break;
        argv.push(w);
      }
      return argv;
    })
    .filter((argv) => !argv[0]?.startsWith('--'));

  test('every run-aerial.sh command parses as the entry point reads it', () => {
    expect(commands.length).toBeGreaterThanOrEqual(5);
    for (const argv of commands) {
      expect(() => parseStageArgs(argv), argv.join(' ')).not.toThrow();
    }
  });

  test('a pilot command names its area, and the pilot list it names is in the package', () => {
    const pilots = commands.filter((a) => a.includes('--pilot') && a[0]?.startsWith('naip-pilot'));
    expect(pilots.length).toBeGreaterThan(0);
    for (const argv of pilots) {
      expect(argv.includes('--cells') || argv.includes('--states'), argv.join(' ')).toBe(true);
    }
    expect(FOLDED).toContain('--cells scripts/aerial/pilots/champlain-nhma-me-ny.txt');
    expect(shipped('pilots/champlain-nhma-me-ny.txt').length).toBeGreaterThan(0);
  });

  test('the foliage review’s command parses', () => {
    expect(FOLDED).toContain(
      'pnpm --filter @skating/aerial foliage naip-<YYYYMMDD> [--threshold 0.6]',
    );
    expect(parseFoliageArgs(['naip-20261212', '--threshold', '0.6'])).toEqual({
      campaign: 'naip-20261212',
      threshold: 0.6,
    });
  });

  /**
   * Every `--flag` the README names, by the tool that takes it. A flag added to the README without
   * a row here fails, so each is placed; a stage flag must parse, a script's must be in its usage.
   */
  const OWNERS: Record<string, 'stage' | 'foliage' | 'cut-aerial' | 'pnpm' | 'fly' | 'external'> = {
    '--stage': 'stage',
    '--pilot': 'stage',
    '--live-since': 'stage',
    '--cells': 'stage',
    '--dry-run': 'stage',
    '--states': 'stage',
    '--from-current': 'stage',
    '--old': 'stage',
    '--threshold': 'foliage',
    '--local': 'cut-aerial',
    '--filter': 'pnpm',
    // flyctl's, as the README quotes them (`fly deploy … --build-only --push`, `fly machine …`):
    // read from `fly deploy --help` by hand; spawn.sh passes the machine-run ones itself.
    '--config': 'fly',
    '--dockerfile': 'fly',
    '--ignorefile': 'fly',
    '--remote-only': 'fly',
    '--build-only': 'fly',
    '--push': 'fly',
    '--image-label': 'fly',
    '--app': 'fly',
    '--force': 'fly',
    '--rm': 'fly',
    '--restart': 'fly',
    '--vm-size': 'fly',
  };
  test('every flag it names is one a tool takes', () => {
    const named = [...new Set(README.match(/--[a-z][a-z0-9-]*/g) ?? [])].sort();
    expect(named.filter((f) => !(f in OWNERS))).toEqual([]);
    const spawn = shipped('spawn.sh');
    for (const flag of named) {
      const owner = OWNERS[flag];
      if (owner === 'stage') {
        const argv =
          flag === '--old' || flag === '--live-since'
            ? [
                'naip-20270801',
                '--stage',
                'cleanup',
                '--old',
                filled('<key>'),
                '--live-since',
                '2027-08-11',
              ]
            : flag === '--pilot'
              ? ['naip-pilot-20261212', '--pilot', 'p']
              : [
                  'naip-20261212',
                  ...(['--dry-run', '--from-current'].includes(flag)
                    ? [flag]
                    : [flag, flag === '--stage' ? 'tiles' : flag === '--states' ? 'NH' : 'c.txt']),
                ];
        expect(() => parseStageArgs(argv), flag).not.toThrow();
      }
      if (owner === 'cut-aerial') expect(shipped('cut-aerial.sh')).toContain(`[${flag} <dir>]`);
      if (owner === 'fly' && ['--rm', '--restart', '--vm-size', '--app'].includes(flag)) {
        expect(spawn).toContain(flag);
      }
    }
  });
});

describe('the README’s keys and paths', () => {
  test('the by-hand delete names exactly the three published keys, for a build and a pilot', () => {
    const loop =
      /for k in (\S+) (\S+) (\S+); do rclone deletefile "\$\{R2_REMOTE:-r2\}:\$R2_BUCKET\/(\S+?)\$k"; done/.exec(
        FOLDED,
      );
    expect(loop).not.toBeNull();
    const [, a, b, c, base] = loop as unknown as [string, string, string, string, string];
    const keys = [a, b, c].map((suffix) => filled(`${base}${suffix}`));
    expect(keys).toEqual([
      archiveKey('naip-20261212'),
      indexKey('naip-20261212'),
      manifestKey('naip-20261212'),
    ]);
    // "a pilot's are under `dev/naip/pilot/<name>/`"
    expect(FOLDED).toContain("a pilot's are under `dev/naip/pilot/<name>/`");
    expect(publishPrefix('naip-pilot-20261212', 'champlain-nhma-me-ny')).toBe(
      filled('dev/naip/pilot/<name>/'),
    );
  });

  test('the build prefix it keeps holds what assemble and verify read again', () => {
    expect(FOLDED).toContain("**Keep the campaign's build prefix** (`naip/build/<campaign>/`");
    expect(FOLDED).not.toMatch(/build prefix deleted once verify passes/);
    const prefix = buildPrefix('naip-20261212');
    expect(prefix).toBe('naip/build/naip-20261212/');
    expect(buildManifestKey('naip-20261212')).toBe(`${prefix}manifest.json`);
  });

  test('the lock it names is where the lock is', () => {
    expect(FOLDED).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's, as the README writes it.
      '`${XDG_CACHE_HOME:-$HOME/.cache}/skating-aerial/locks/<campaign>.lock`',
    );
    expect(
      lockPath(
        lockDir(() => undefined, '/Users/op'),
        'naip-20261212',
      ),
    ).toBe('/Users/op/.cache/skating-aerial/locks/naip-20261212.lock');
    expect(
      lockPath(
        lockDir((n) => (n === 'XDG_CACHE_HOME' ? '/x' : undefined), '/h'),
        'c',
      ),
    ).toBe('/x/skating-aerial/locks/c.lock');
  });

  test('an assembly record lost after its manifest is refused in the README’s words: exactly those three keys, only while nothing has served them', async () => {
    const w = new FakeWorld();
    try {
      const m = await fixtureManifest();
      w.put(buildManifestKey(m.campaign), m);
      for (const wt of m.workTiles) {
        const [, x, y] = wt.key.split('/');
        w.put(
          `${buildPrefix(m.campaign)}shards/11/${x}/${y}.done.json`,
          doneRecord(m.campaign, wt.key, wt.inputHash),
        );
      }
      w.put(manifestKey(m.campaign), m);
      let refused: unknown;
      try {
        await runAssembleStage([m.campaign], w.world());
      } catch (e) {
        refused = e;
      }
      expect((refused as StageRefusal).id).toBe('assemble.publishedNoRecord');
      const message = (refused as Error).message;
      expect(message).toContain('Only while nothing has served them');
      expect(message).toContain(
        `delete exactly these three published keys by hand: ${archiveKey(m.campaign)}, ${indexKey(m.campaign)}, ${manifestKey(m.campaign)};`,
      );
      expect(message).toContain('the build prefix, its shards and its manifest stay');
    } finally {
      w.dispose();
    }
  });
});

describe('the README’s variables', () => {
  /** Variables read by a tool outside this package, by the tool. */
  const OUTSIDE: Record<string, string> = {
    CONVEX_DEPLOYMENT: '@skating/run-log (resolveDeployment)',
    FLY_API_TOKEN: 'flyctl',
    CPL_AZURE_ENDPOINT: 'GDAL',
    CPL_AZURE_USE_HTTPS: 'GDAL',
    VITE_NAIP_PMTILES_URL: 'apps/web',
    VITE_IMAGERY_ARCHIVE_URL: 'apps/web',
    FLY_IMAGE: "the winter cutter's (named only to say it is never touched)",
    HEAD: 'an HTTP method, not a variable',
  };
  const sources = [
    'spawn.sh',
    'cut-aerial.sh',
    'assemble-aerial.sh',
    'run-aerial.sh',
    'Dockerfile',
    'src/preflight.ts',
    'src/campaignLock.ts',
    'src/world.ts',
    'src/stage/selectRun.ts',
    'src/cli/assemble.ts',
    'src/cli/verify.ts',
    'src/tiles.ts',
  ]
    .map(shipped)
    .join('\n');

  test('every variable it names is read by the package, or is a core constant, or is named here', () => {
    const named = [
      ...new Set(
        [...README.matchAll(/`([A-Z][A-Z0-9_]{2,})(?:=[^`]*)?`/g)].map((m) => m[1] as string),
      ),
    ].sort();
    expect(named.length).toBeGreaterThan(20);
    const unread = named.filter(
      (v) => !(v in OUTSIDE) && !(v in core) && !new RegExp(`\\b${v}\\b`).test(sources),
    );
    expect(unread).toEqual([]);
  });
});
