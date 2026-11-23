/**
 * **The photo steps' upload** — what the app does with a photo, done by the script: an upload address
 * from `photos:generateUploadUrl` as the step's person, then an HTTP POST of the file's bytes, which
 * answers the stored id. Dev only: the plan that asks for it is served only on dev (the seed's exact
 * host gate), and the address must be the target deployment's own host before a byte is sent. The
 * address is never printed, logged or kept: it goes to the POST through its stdin, not its arguments.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import type { RunAs } from '@skating/run-log';
import { seedPng } from './png';
import { type Call, releaseUploads, type SeedCall, type Upload, UploadFailed } from './seed';

/** The full image's side and the thumbnail's, in pixels: small, real PNGs. */
export const FULL_PX = 64;
export const THUMB_PX = 16;

/**
 * What an upload address may point at: the dev deployment's own origin, by the server's own rule for
 * "this is dev" (`packages/convex/convex/lib/deployment.ts` `isDevDeployment`): `https:`, exactly
 * `<name>.convex.cloud`, no port — never a look-alike host, a host in a path, plain `http:` or another
 * port. `null` when it may; otherwise why not (no address in the words). The two are held to one table
 * of addresses (`UPLOAD_HOST_CASES`).
 */
export function uploadRefusal(url: string, deploymentName: string | null): string | null {
  if (deploymentName === null) return 'Photos are uploaded to a dev deployment only.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'The upload address could not be read; nothing was sent.';
  }
  const own =
    parsed.protocol === 'https:' &&
    parsed.hostname === `${deploymentName}.convex.cloud` &&
    parsed.port === '';
  return own ? null : 'The upload address is not this deployment’s; nothing was sent.';
}

/**
 * The addresses both rules are held to, with whether each is the deployment's own — the server's own
 * cases (`deployment.test.ts`) with an upload path: each must read the same here as `isDevDeployment`
 * reads the address's origin there.
 */
export const UPLOAD_HOST_CASES = (name: string): readonly [string, boolean][] => [
  [`https://${name}.convex.cloud/api/storage/upload?token=t`, true],
  [`https://${name}.convex.cloud:443/api/storage/upload`, true],
  [`https://x${name}.convex.cloud/api/storage/upload`, false],
  [`https://${name}.convex.cloud.evil.example/api/storage/upload`, false],
  [`http://${name}.convex.cloud/api/storage/upload`, false],
  [`https://${name}.convex.cloud:8443/api/storage/upload`, false],
  [`https://evil.example/${name}.convex.cloud/api/storage/upload`, false],
  ['http://127.0.0.1:3210/api/storage/upload', false],
  ['', false],
  ['not a url', false],
];

/** The POST itself, run by `node -e`: its stdin is `{ url, type, body }` (body in base64). */
export const POST = `
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  const { url, type, body } = JSON.parse(input);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body: Buffer.from(body, 'base64') });
    const text = await res.text();
    if (!res.ok) { process.stderr.write('upload answered ' + res.status); process.exitCode = 1; return; }
    process.stdout.write(text);
  } catch (err) {
    process.stderr.write('upload failed: ' + (err && err.message));
    process.exitCode = 1;
  }
});
`;

/** POST `bytes` to `url` and answer the stored id; throws on any failure, never with the address. */
export function postFile(url: string, bytes: Buffer, type = 'image/png'): string {
  const res = spawnSync(process.execPath, ['-e', POST], {
    input: JSON.stringify({ url, type, body: bytes.toString('base64') }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`The photo upload failed: ${res.stderr || 'no answer'}`);
  const id = (JSON.parse(res.stdout) as { storageId?: unknown }).storageId;
  if (typeof id !== 'string') throw new Error('The photo upload answered no stored id.');
  return id;
}

/**
 * The CLI's uploader: for each of the step's two files, an address as its person (checked against
 * `deploymentName`, the dev deployment the run targets), then the POST. A failure partway — the
 * thumbnail's address or POST after the image went up — releases what went up ({@link UploadFailed}
 * carries anything that couldn't be).
 */
export function uploader(
  call: Call,
  deploymentName: string | null,
  post: (url: string, bytes: Buffer) => string = postFile,
): Upload {
  return (step: SeedCall, runAs: RunAs | undefined) => {
    const one = (slot: 'full' | 'thumb') => {
      const url = call<string>('photos:generateUploadUrl', {}, runAs);
      const refused = uploadRefusal(url, deploymentName);
      if (refused !== null) throw new Error(refused);
      return post(url, seedPng(`${step.key}:${slot}`, slot === 'full' ? FULL_PX : THUMB_PX));
    };
    const up: string[] = [];
    try {
      up.push(one('full'));
      up.push(one('thumb'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UploadFailed(message, releaseUploads(call, up, runAs));
    }
    return { storageId: up[0] as string, thumbStorageId: up[1] as string };
  };
}
