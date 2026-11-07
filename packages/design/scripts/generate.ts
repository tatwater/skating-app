/**
 * Regenerate every consumer's token file from the source: `pnpm --filter @skating/design generate`.
 *
 * Writes `_generated/` (CSS custom properties, the Tailwind wiring, the React Native module and the
 * resolved JSON). Deterministic — the same source writes byte-identical files — and the test suite
 * fails if the committed files drift from what this would write.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/tokens/emit';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '_generated');
mkdirSync(outDir, { recursive: true });
for (const [file, contents] of Object.entries(generateAll())) {
  writeFileSync(join(outDir, file), contents);
  console.log(`_generated/${file}`);
}
