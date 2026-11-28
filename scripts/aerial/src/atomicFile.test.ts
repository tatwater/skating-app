import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { writeFileAtomic } from './atomicFile';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aerial-atomic-'));
  dirs.push(d);
  return d;
};

describe('writeFileAtomic', () => {
  test('replaces the file whole, creates its directory, and leaves no part file', () => {
    const dir = tmp();
    const path = join(dir, 'nested', 'scores.json');
    writeFileAtomic(path, 'one');
    writeFileAtomic(path, new Uint8Array(Buffer.from('two')));
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(readdirSync(join(dir, 'nested'))).toEqual(['scores.json']);
  });

  test('a write that fails leaves the old file and no part file', () => {
    const dir = tmp();
    // A directory where the file should be: the rename fails.
    mkdirSync(join(dir, 'taken'));
    mkdirSync(join(dir, 'taken', 'inside'));
    expect(() => writeFileAtomic(join(dir, 'taken'), 'x')).toThrow();
    expect(readdirSync(dir)).toEqual(['taken']);
  });
});
