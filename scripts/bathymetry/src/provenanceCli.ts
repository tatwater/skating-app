/**
 * Regenerate the committed provenance record (N6b).
 *
 *   pnpm --filter @skating/bathymetry provenance
 *
 * Thin I/O around `renderProvenance`, which is pure and tested. Excluded from coverage.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readManifest } from './cache';
import { renderProvenance } from './provenance';
import { SOURCES } from './sources';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'PROVENANCE.md');

function main(): void {
  const entries = SOURCES.map((source) => ({ source, manifest: readManifest(source.key) }));

  // The date, not the clock. `renderProvenance` takes it as an argument precisely so the output is a
  // pure function of the archive — a renderer that stamped the time would dirty the file on every run.
  const generatedAt = new Date().toISOString();
  writeFileSync(OUT, `${renderProvenance(entries, generatedAt)}`);

  const missing = entries.filter((e) => !e.manifest).length;
  process.stderr.write(
    `[bathymetry] wrote PROVENANCE.md · ${entries.length - missing}/${entries.length} sources archived\n`,
  );
}

main();
