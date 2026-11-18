import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import expoEnv from '@expo/env';

const projectRoot = process.cwd();
// Match Expo's dotenv precedence, but only pass the Firebase input to the EAS CLI.
const configuredPath =
  process.env.GOOGLE_SERVICES_JSON ??
  expoEnv.parseProjectEnv(projectRoot, { silent: true }).env.GOOGLE_SERVICES_JSON;
const googleServicesFile = [configuredPath, './google-services.json']
  .filter(Boolean)
  .map((path) => resolve(projectRoot, path))
  .find((path) => statSync(path, { throwIfNoEntry: false })?.isFile());

if (!googleServicesFile) {
  console.error(
    'Android preview needs a local google-services.json matching the EAS preview file. See docs/deployment-and-release.md.',
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(
    'eas',
    [
      'build',
      '--profile',
      'preview',
      '--platform',
      'android',
      '--no-wait',
      ...process.argv.slice(2),
    ],
    {
      env: { ...process.env, GOOGLE_SERVICES_JSON: googleServicesFile },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
