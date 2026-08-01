/**
 * Per-state provenance records (N6b) — the committed half of the archive.
 *
 * `.raw/` is gitignored, so on a fresh clone the repo knows nothing about what we hold, when we got
 * it, or under what terms. This renders that into `PROVENANCE.md`, which **is** committed: where each
 * state's data came from, when it was captured, how much of it there is, what the agency's licence
 * text said at capture time, and the exact one-line command to refresh that state alone.
 *
 * The organising principle is **per state**, not per fetch. Agencies republish independently — NH
 * updated in Feb 2024, Vermont's 2020-named archive has a 2026 `last-modified` — so "our records are
 * out of date" is a per-state judgement and refreshing has to be a per-state action. A single
 * everything-at-once record would make the common case (one state moved) look like a full re-fetch.
 *
 * The rendering is pure and tested; the CLI at the bottom is I/O.
 */

import type { BathymetrySource, RawManifest } from './types';

export interface ProvenanceEntry {
  source: BathymetrySource;
  /** Absent when a source has never been fetched — rendered as such rather than omitted. */
  manifest?: RawManifest;
}

function bytesOf(manifest: RawManifest): number {
  return manifest.files.reduce((total, file) => total + file.bytes, 0);
}

function humanBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} kB`;
  return `${bytes} B`;
}

/**
 * A content fingerprint for a whole snapshot, independent of file order or page count.
 *
 * Concatenating the per-file checksums in sorted order means two snapshots compare equal exactly when
 * they hold the same bytes — so this is the thing to eyeball when asking "is my archive the same one
 * that produced the current tiles?" It deliberately does **not** hash the manifest itself, which
 * carries a fetch timestamp and would therefore differ on every re-fetch of identical data.
 */
export function snapshotFingerprint(manifest: RawManifest): string {
  const combined = manifest.files
    .map((f) => f.sha256)
    .sort()
    .join('');
  // A short, stable digest of the digests. FNV-1a is plenty for an eyeball comparison and keeps this
  // module pure (no node:crypto import in the tested path).
  let hash = 0x811c9dc5;
  for (let i = 0; i < combined.length; i += 1) {
    hash ^= combined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** ISO timestamp → the date alone. Provenance is a day-level fact; the clock time is noise. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Render the committed provenance record.
 *
 * `generatedAt` is injected rather than read from the clock so the output is a pure function of its
 * inputs — which matters because this file is committed, and a renderer that stamped `Date.now()`
 * would produce a diff on every run whether or not anything changed.
 */
export function renderProvenance(entries: readonly ProvenanceEntry[], generatedAt: string): string {
  const states = [...new Set(entries.map((e) => e.source.state))].sort();
  const fetched = entries.filter((e) => e.manifest);
  const totalBytes = fetched.reduce((total, e) => total + bytesOf(e.manifest as RawManifest), 0);

  const lines: string[] = [
    '# Bathymetry source provenance',
    '',
    '> **Generated — do not edit by hand.** Run `pnpm --filter @skating/bathymetry provenance`.',
    '>',
    "> This is the committed record of an archive that isn't committed. `.raw/` holds hundreds of MB",
    '> of third-party data and is gitignored; this file is how the repo still knows what we hold, when',
    '> we captured it, and under what terms.',
    '',
    `Generated ${day(generatedAt)} · ${fetched.length}/${entries.length} sources archived · ${humanBytes(totalBytes)} total.`,
    '',
    '## Refreshing',
    '',
    'Agencies republish independently, so **staleness is a per-state judgement** and refreshing is a',
    'per-state action. Check first, then refresh only what moved:',
    '',
    '```bash',
    'pnpm --filter @skating/bathymetry verify              # two cheap requests per source, no payload',
    'pnpm --filter @skating/bathymetry verify --state=NH   # or just one state',
    '',
    'pnpm --filter @skating/bathymetry snapshot --state=NH --refresh   # re-capture that state',
    'scripts/bathymetry/mirror-r2.sh push                              # then mirror it',
    'pnpm --filter @skating/bathymetry provenance                      # then regenerate this file',
    '```',
    '',
    'A refresh **replaces** a snapshot. If you need the old one, pull it from the mirror first — the',
    'mirror is `rclone copy`, never `sync`, so a previous push is still there.',
    '',
  ];

  for (const state of states) {
    lines.push(`## ${state}`, '');
    for (const entry of entries.filter((e) => e.source.state === state)) {
      const { source, manifest } = entry;
      lines.push(`### ${source.agency} — \`${source.key}\``, '');

      if (!manifest) {
        lines.push(
          '⚠ **Never fetched.** Run',
          `\`pnpm --filter @skating/bathymetry snapshot ${source.key}\`.`,
          '',
        );
      }

      const rows: [string, string][] = [
        [
          'Lane',
          source.kind === 'contours' ? 'contours (state-surveyed)' : 'soundings (we interpolate)',
        ],
        ['Native unit', source.unit],
        ['Vertical datum', source.datum],
        ['Source page', `<${source.sourceUrl}>`],
        ['Endpoint', `\`${source.fetch.url}\``],
        ['Credit we render', source.attribution],
        // Rendered as its own row rather than folded into the credit: a notice the source's terms
        // require is a different obligation from a credit, and a reader checking one should not have
        // to parse the other to find it.
        ...(source.notice ? [['Required notice', source.notice] as [string, string]] : []),
      ];
      if (manifest) {
        rows.push(
          ['Captured', day(manifest.fetchedAt)],
          [
            'Records',
            manifest.recordCount !== undefined ? String(manifest.recordCount) : '— (opaque file)',
          ],
          ['Files', `${manifest.files.length} · ${humanBytes(bytesOf(manifest))}`],
          ['Fingerprint', `\`${snapshotFingerprint(manifest)}\``],
        );
        // The agency's own words at capture time, kept verbatim and distinct from the credit we chose
        // to render. A drift between the two is a thing to read, not to auto-resolve.
        rows.push([
          'Agency copyright at capture',
          manifest.service?.copyrightText
            ? `*${manifest.service.copyrightText}*`
            : '*(none published)*',
        ]);
        if (manifest.http?.lastModified)
          rows.push(['Server last-modified', manifest.http.lastModified]);
      }

      lines.push('| | |', '| --- | --- |');
      for (const [key, value] of rows) lines.push(`| **${key}** | ${value} |`);
      lines.push('');

      if (source.notes) {
        lines.push('<details><summary>Field notes (traps found in the real data)</summary>', '');
        lines.push(source.notes, '', '</details>', '');
      }
    }
  }

  lines.push(
    '## New York',
    '',
    '**No statewide lake bathymetry exists to archive.** This is a checked finding, not a gap — see',
    '`plans/phase-N6b-bathymetry-layer.md` §New York for the search that established it and for the',
    'costed digitisation path if we ever fund it.',
    '',
    'New York is nonetheless covered where it matters most: the VCGI/NOAA Champlain source above spans',
    'the whole lake, including its entire New York shore.',
    '',
  );

  return lines.join('\n');
}
