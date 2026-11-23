import { describe, expect, test } from 'vitest';
import { logSafe, MAX_ERROR_LENGTH, serverSentence } from './serverSentence';

describe('serverSentence', () => {
  test('the server’s sentence, never the echoed command', () => {
    const stderr = [
      'Command failed: pnpm --filter @skating/convex exec convex run contentFlags:flag {…}',
      'Error: [CONVEX M(contentFlags:flag)] [Request ID: 1] Server Error',
      'Uncaught ConvexError: You have already asked — it is with the moderators.',
      '    at handler (../convex/contentFlags.ts:120:11)',
    ].join('\n');
    expect(serverSentence(stderr)).toBe('You have already asked — it is with the moderators.');
    expect(serverSentence('Uncaught Error: Not authenticated')).toBe('Not authenticated');
    expect(serverSentence('Command failed: pnpm …\n✖ Could not reach the deployment\n')).toBe(
      '✖ Could not reach the deployment',
    );
    expect(serverSentence('Command failed: pnpm …')).toBe('convex run failed with no message');
  });

  test('a call the CLI could not make: the server’s sentence, never pnpm’s line or the function list', () => {
    // As `convex run` wrote it on dev for the `mp-bounty` step (#173): an internal function called
    // as a person, the request boilerplate, every function the deployment has, then pnpm's wrapper.
    const stderr = [
      '\u001b[31m✖ Failed to run function "bounties:createChecked":',
      'Error: [Request ID: 6a1f] Server Error',
      "Could not find function for 'bounties:createChecked'. Did you forget to run `npx convex dev`?\u001b[39m",
      '',
      'Available functions:',
      '• bounties:create',
      '• reports:create',
      '/Users/someone/skating/packages/convex:',
      ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 1: convex run bounties:createChecked {…}',
    ].join('\n');
    expect(serverSentence(stderr)).toBe(
      "Could not find function for 'bounties:createChecked'. Did you forget to run `npx convex dev`?",
    );
    // Nothing after the heading: the heading itself.
    expect(serverSentence('Failed to run function "x:y":\n\nAvailable functions:')).toBe(
      'Failed to run function "x:y":',
    );
    // pnpm's line is never the answer, even when it is the last.
    expect(
      serverSentence(
        '✖ Could not reach the deployment\n ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed',
      ),
    ).toBe('✖ Could not reach the deployment');
  });

  test('an error in the log is bounded, and never carries an environment value', () => {
    expect(serverSentence('Uncaught Error: bad CONVEX_DEPLOY_KEY=dev:abc|secret here')).toBe(
      'bad CONVEX_DEPLOY_KEY=… here',
    );
    const long = serverSentence(`Uncaught ConvexError: ${'x'.repeat(1_000)}`);
    expect(long).toHaveLength(MAX_ERROR_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    expect(logSafe('  short  ')).toBe('short');
  });
});
