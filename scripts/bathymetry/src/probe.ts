/**
 * Discovery CLI (N6b) — look at a candidate layer before committing it to the registry.
 *
 *   pnpm --filter @skating/bathymetry probe <layer-url> [--save=<key>]
 *
 * Answers the three questions that decide which lane a state belongs in, and in what order:
 *
 *   1. **Lines or points?** `esriGeometryPolyline` means the agency surveyed isobaths and we tile what
 *      they published. `esriGeometryPoint` means soundings, and *we* fit the surface — a weaker
 *      provenance claim that has to be labelled differently in the UI (§Maine).
 *   2. **How much is there?** The record count sizes the fetch and, for a sounding lane, is the first
 *      input to the density gate.
 *   3. **What are we required to say?** `copyrightText` is where an agency's credit wording actually
 *      lives, and §5 renders it.
 *
 * This exists as its own command because the phase's plan got question 1 wrong for Vermont — the doc
 * recorded VT as publishing isobaths when both its datasets are point clouds, which inverted the
 * phase's whole sequencing argument. A probe is thirty seconds and it is the difference between
 * reading a source table and knowing.
 *
 * With `--save`, the descriptor is written into `.raw/<key>/descriptor.json`, so discovery contributes
 * to the archive rather than scrolling past in a terminal.
 */

import process from 'node:process';
import { countUrl, descriptorUrl, parseCount, preferredFormat } from './arcgis';
import { ensureRawDir, getText, writeRawFile } from './cache';
import { normalizeDescriptor, objectIdField } from './manifest';

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  const saveKey = flag(args, 'save');

  if (!url) {
    process.stderr.write(
      'usage: pnpm --filter @skating/bathymetry probe <layer-url> [--save=<key>]\n',
    );
    process.exit(1);
  }

  const descriptorBody = await getText(descriptorUrl(url));
  const raw = JSON.parse(descriptorBody) as Record<string, unknown>;
  if (raw.error) {
    process.stderr.write(`[probe] service returned an error: ${JSON.stringify(raw.error)}\n`);
    process.exit(1);
  }
  const descriptor = normalizeDescriptor(raw);

  let count: number | undefined;
  try {
    count = parseCount(await getText(countUrl(url)));
  } catch (error) {
    // A MapServer layer that refuses a count is still worth probing — the geometry type and the
    // fields are the load-bearing half. Report the refusal rather than failing the whole probe.
    process.stderr.write(`[probe] count unavailable: ${(error as Error).message}\n`);
  }

  const kind =
    descriptor.geometryType === 'esriGeometryPolyline'
      ? 'contours (agency-surveyed isobaths — we tile what they published)'
      : descriptor.geometryType === 'esriGeometryPoint'
        ? 'soundings (we interpolate — weaker provenance claim, needs a density gate)'
        : `unexpected geometry: ${descriptor.geometryType ?? 'none reported'}`;

  const lines = [
    `layer            ${descriptor.name ?? '(unnamed)'}`,
    `geometry         ${descriptor.geometryType ?? '(none)'}`,
    `→ lane           ${kind}`,
    `records          ${count ?? '(unavailable)'}`,
    `maxRecordCount   ${descriptor.maxRecordCount ?? '(unreported)'}`,
    `pagination       ${descriptor.supportsPagination ?? '(unreported)'}`,
    `query format     ${preferredFormat(descriptor.supportedQueryFormats)} (advertised: ${descriptor.supportedQueryFormats ?? 'none'})`,
    `spatialReference ${descriptor.spatialReference ?? '(unreported)'}`,
    `OID field        ${objectIdField(descriptor) ?? '(none — cannot page in a stable order)'}`,
    `copyrightText    ${descriptor.copyrightText ?? '(none published)'}`,
    '',
    'fields:',
    ...descriptor.fields.map(
      (f) => `  ${f.name.padEnd(20)} ${f.type.replace('esriFieldType', '')}`,
    ),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  if (descriptor.description) {
    process.stdout.write(`\ndescription:\n  ${descriptor.description.slice(0, 800)}\n`);
  }

  if (saveKey) {
    ensureRawDir(saveKey);
    writeRawFile(saveKey, 'descriptor.json', Buffer.from(descriptorBody, 'utf8'));
    process.stderr.write(`\n[probe] descriptor saved to .raw/${saveKey}/descriptor.json\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[probe] ${(error as Error).message}\n`);
  process.exit(1);
});
