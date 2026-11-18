import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';
import { expect, test } from 'vitest';

test('checkpoints, flushes a Sentry span on Ctrl-C, and resumes only missing points', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'elevation-test-'));
  const envelopes: string[] = [];
  const collector = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    envelopes.push(
      (req.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes).toString(),
    );
    res.end('{}');
  });
  collector.listen(0, '127.0.0.1');
  try {
    await once(collector, 'listening');
    const address = collector.address();
    if (!address || typeof address === 'string') throw new Error('No local collector port');
    const dsn = `http://public@127.0.0.1:${address.port}/42`;
    const requests = join(dir, 'requests.ndjson');
    const runLog = join(dir, 'run-log.ndjson');
    const bodies = join(dir, 'bodies.ndjson');
    const archive = join(dir, 'archive');
    const preload = join(dir, 'usgs.mjs');
    await writeFile(
      bodies,
      Array.from({ length: 260 }, (_, i) =>
        JSON.stringify({ interiorPoint: { lat: 40 + i / 10_000, lng: -72 } }),
      ).join('\n'),
    );
    await writeFile(
      preload,
      `import { appendFileSync } from 'node:fs';
const requests = ${JSON.stringify(requests)};
let first = true;
globalThis.fetch = async (url, { signal }) => {
  const index = Math.round((Number(new URL(url).searchParams.get('y')) - 40) * 10_000);
  appendFileSync(requests, JSON.stringify(index) + '\\n');
  if (index === 0 && first) {
    first = false;
    return new Response('busy', { status: 503 });
  }
  if (index >= 250 && process.env.FIXTURE_INTERRUPT === 'yes') {
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  return Response.json({ value: '171.25', resolution: 1 });
};`,
    );
    // RunLogger still exercises its actual CLI adapter, but no Convex request leaves this test.
    await writeFile(
      join(dir, 'pnpm'),
      `#!/bin/sh
[ "$2" = "@skating/convex" ] && [ "$5" = run ] || exit 1
printf '%s\\n' "$7" >> "$FIXTURE_RUN_LOG"
printf '"fixture-run"\\n'
`,
      { mode: 0o755 },
    );

    const run = async (interrupt: boolean) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--import',
          preload,
          'src/snapshotElevation.ts',
          `--from=${bodies}`,
          `--archive-dir=${archive}`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            CONVEX_DEPLOYMENT: 'dev:fixture',
            SCRIPT_SENTRY_DSN: dsn,
            FIXTURE_RUN_LOG: runLog,
            FIXTURE_INTERRUPT: interrupt ? 'yes' : 'no',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      let stderr = '';
      let stopped = false;
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (interrupt && !stopped && stderr.includes('250/260')) {
          stopped = true;
          child.kill('SIGINT');
        }
      });
      try {
        const [code] = await once(child, 'close');
        return { code, stderr };
      } finally {
        clearTimeout(timer);
      }
    };

    const interrupted = await run(true);
    expect(interrupted.code, interrupted.stderr).toBe(130);
    expect(interrupted.stderr).toContain('Stopped by SIGINT; 250 new readings saved.');
    const manifest = async () => JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'));
    expect((await manifest()).entries).toBe(250);
    const log = async () =>
      (await readFile(runLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    expect(await log()).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('Stopped by SIGINT'),
        counts: expect.arrayContaining([{ name: 'fetched', value: 250 }]),
      }),
    );

    await writeFile(requests, '');
    const resumed = await run(false);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect((await manifest()).entries).toBe(260);
    expect(
      (await readFile(requests, 'utf8'))
        .trim()
        .split('\n')
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 10 }, (_, i) => i + 250));
    expect(await log()).toContainEqual(expect.objectContaining({ status: 'succeeded' }));

    const wire = envelopes.join('\n');
    const spans = envelopes.flatMap(
      (envelope) => JSON.parse(envelope.split('\n')[2] ?? '{}').items,
    );
    expect(spans).toEqual([
      expect.objectContaining({
        name: '3dep.snapshot.fetch',
        attributes: expect.objectContaining({
          'snapshot.outcome': { value: 'interrupted', type: 'string' },
          'snapshot.fetched': { value: 250, type: 'integer' },
          'snapshot.retries': { value: 1, type: 'integer' },
        }),
      }),
      expect.objectContaining({
        name: '3dep.snapshot.fetch',
        attributes: expect.objectContaining({
          'snapshot.outcome': { value: 'completed', type: 'string' },
          'snapshot.fetched': { value: 10, type: 'integer' },
          'snapshot.retries': { value: 0, type: 'integer' },
        }),
      }),
    ]);
    expect(wire).not.toContain(bodies);
    expect(wire).not.toContain('epqs.nationalmap.gov');
  } finally {
    collector.closeAllConnections();
    collector.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 40_000);
