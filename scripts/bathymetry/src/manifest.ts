/**
 * Manifest construction and **drift detection** for the raw snapshot cache (N6b).
 *
 * The archive's job is to make reprocessing free. This module's job is the other half: noticing when
 * an agency has republished underneath us. That matters more here than it looks, because every failure
 * it catches is silent by nature — a renamed column reads zero contours and reports success, a changed
 * `copyrightText` means we are rendering a credit line the agency no longer asks for, and a doubled
 * record count means a state merged two surveys and our density gate is now measuring something else.
 *
 * N6a learned this the expensive way: its transform matches CSV headers case-insensitively and raises
 * a *named* error listing the headers it actually found, precisely so a third-party rename fails loudly.
 * `diffManifests` is that discipline moved one stage earlier — to the fetch, where the change is
 * observable before any transform has had a chance to shrug it off.
 *
 * Everything here is pure: manifests in, report out. The file I/O lives in `cache.ts`.
 */

import type { HttpValidators, RawFileRecord, RawManifest, ServiceDescriptor } from './types';

/**
 * An ArcGIS `?f=json` layer descriptor → the fields we depend on.
 *
 * Deliberately tolerant of shape: these are five different agencies running four ArcGIS versions, and
 * a missing `supportsPagination` should mean "we'll find out" rather than a crash during discovery.
 * What we do **not** tolerate is inventing values — an absent field stays absent, so `verify` can tell
 * "the agency stopped publishing a copyright" apart from "we defaulted it to empty".
 */
export function normalizeDescriptor(raw: unknown): ServiceDescriptor {
  const d = (raw ?? {}) as Record<string, unknown>;
  const rawFields = Array.isArray(d.fields) ? d.fields : [];
  const fields = rawFields
    .map((f) => f as Record<string, unknown>)
    .filter((f) => typeof f.name === 'string')
    .map((f) => ({ name: f.name as string, type: String(f.type ?? 'unknown') }));

  const descriptor: ServiceDescriptor = { fields };
  if (typeof d.name === 'string') descriptor.name = d.name;
  if (typeof d.geometryType === 'string') descriptor.geometryType = d.geometryType;
  if (typeof d.maxRecordCount === 'number') descriptor.maxRecordCount = d.maxRecordCount;
  if (typeof d.description === 'string') descriptor.description = d.description;
  if (typeof d.supportsPagination === 'boolean') {
    descriptor.supportsPagination = d.supportsPagination;
  } else if (
    typeof d.advancedQueryCapabilities === 'object' &&
    d.advancedQueryCapabilities !== null
  ) {
    const adv = d.advancedQueryCapabilities as Record<string, unknown>;
    if (typeof adv.supportsPagination === 'boolean')
      descriptor.supportsPagination = adv.supportsPagination;
  }
  if (typeof d.supportedQueryFormats === 'string') {
    descriptor.supportedQueryFormats = d.supportedQueryFormats;
  }
  // Agencies pad the credit with newlines and trailing spaces (NH's carries both). Collapse whitespace
  // so a cosmetic reformat on their side doesn't read to `verify` as a licence change on ours.
  if (typeof d.copyrightText === 'string') {
    const collapsed = d.copyrightText.replace(/\s+/g, ' ').trim();
    if (collapsed.length > 0) descriptor.copyrightText = collapsed;
  }
  // Hosted feature layers omit a top-level `spatialReference` and report it only inside `extent`
  // (NH GRANIT's does exactly this). Falling back keeps the projection knowable for every service we
  // actually have to fetch, rather than for the subset that reports it where the docs say it should.
  const extent = d.extent as Record<string, unknown> | undefined;
  const sr = (d.spatialReference ?? extent?.spatialReference) as
    | Record<string, unknown>
    | undefined;
  if (sr && typeof sr === 'object') {
    const wkid = sr.latestWkid ?? sr.wkid;
    if (typeof wkid === 'number' || typeof wkid === 'string') descriptor.spatialReference = wkid;
  }
  return descriptor;
}

/**
 * The OID field's name, needed for stable pagination (`orderByFields`).
 *
 * ArcGIS names it `OBJECTID`, `FID`, `objectid`, or whatever the publisher chose — NH's is `fid` —
 * so it is read from the field types rather than guessed. Returns `undefined` when the layer declares
 * none, which the pager treats as "this service cannot be ordered" rather than defaulting to a name
 * that would silently produce an unordered, overlapping page sequence.
 */
export function objectIdField(descriptor: ServiceDescriptor): string | undefined {
  return descriptor.fields.find((f) => f.type === 'esriFieldTypeOID')?.name;
}

export interface BuildManifestInput {
  key: string;
  fetchedAt: string;
  sourceUrl: string;
  sourceKind: RawManifest['source']['kind'];
  format?: RawManifest['source']['format'];
  files: RawFileRecord[];
  recordCount?: number;
  service?: ServiceDescriptor;
  http?: HttpValidators;
}

/** Assemble a manifest. Trivial, but it is the one place the on-disk shape is decided. */
export function buildManifest(input: BuildManifestInput): RawManifest {
  const manifest: RawManifest = {
    key: input.key,
    fetchedAt: input.fetchedAt,
    source: { url: input.sourceUrl, kind: input.sourceKind },
    files: input.files,
  };
  if (input.format) manifest.source.format = input.format;
  if (input.recordCount !== undefined) manifest.recordCount = input.recordCount;
  if (input.service) manifest.service = input.service;
  if (input.http) manifest.http = input.http;
  return manifest;
}

/** How serious a drift is. `breaking` means a transform written against the old snapshot is now wrong. */
export type DriftSeverity = 'breaking' | 'notable' | 'cosmetic';

export interface DriftFinding {
  severity: DriftSeverity;
  /** What changed, in the terms the person re-running the ETL thinks in. */
  message: string;
}

export interface DriftReport {
  changed: boolean;
  findings: DriftFinding[];
}

/**
 * Compare a stored manifest against what the source looks like now.
 *
 * `next` is deliberately a **partial** manifest: `verify` builds it from a descriptor fetch and a
 * count query, which is two cheap requests, and never pulls the payload. That is the whole point —
 * checking for drift has to be cheaper than refetching or nobody will run it.
 *
 * The severity split is the useful output, not the boolean:
 *
 * - **breaking** — a field the transform reads has disappeared, or the geometry type changed. Code is
 *   now wrong, not merely stale.
 * - **notable** — record count moved, or the licence wording changed. Nothing crashes; a human has to
 *   look, because one of them changes what we render and the other changes what we may render.
 * - **cosmetic** — a field was *added*, or a validator moved with no other evidence of change. Worth
 *   printing, not worth blocking on.
 *
 * A removed field outranks a changed count on purpose: a count drift is usually a genuine
 * republication (good, refetch), where a vanished column is the failure that reads as success.
 */
export function diffManifests(prev: RawManifest, next: Partial<RawManifest>): DriftReport {
  const findings: DriftFinding[] = [];

  if (next.source?.url && next.source.url !== prev.source.url) {
    findings.push({
      severity: 'notable',
      message: `source URL changed: ${prev.source.url} → ${next.source.url}`,
    });
  }

  const prevFields = prev.service?.fields ?? [];
  const nextFields = next.service?.fields;
  if (nextFields) {
    const nextNames = new Set(nextFields.map((f) => f.name));
    const prevNames = new Set(prevFields.map((f) => f.name));
    const removed = prevFields.filter((f) => !nextNames.has(f.name)).map((f) => f.name);
    const added = nextFields.filter((f) => !prevNames.has(f.name)).map((f) => f.name);
    if (removed.length > 0) {
      findings.push({
        severity: 'breaking',
        message: `field(s) removed: ${removed.join(', ')} — any transform reading them now reads nothing`,
      });
    }
    if (added.length > 0) {
      findings.push({ severity: 'cosmetic', message: `field(s) added: ${added.join(', ')}` });
    }
    // A retype is as breaking as a removal and much easier to miss: `depth` going text keeps the name
    // and every numeric read of it starts producing NaN.
    for (const f of nextFields) {
      const before = prevFields.find((p) => p.name === f.name);
      if (before && before.type !== f.type) {
        findings.push({
          severity: 'breaking',
          message: `field ${f.name} changed type: ${before.type} → ${f.type}`,
        });
      }
    }
  }

  const prevGeom = prev.service?.geometryType;
  const nextGeom = next.service?.geometryType;
  if (prevGeom && nextGeom && prevGeom !== nextGeom) {
    findings.push({
      severity: 'breaking',
      message: `geometry type changed: ${prevGeom} → ${nextGeom}`,
    });
  }

  if (
    prev.recordCount !== undefined &&
    next.recordCount !== undefined &&
    prev.recordCount !== next.recordCount
  ) {
    const delta = next.recordCount - prev.recordCount;
    findings.push({
      severity: 'notable',
      message: `record count changed: ${prev.recordCount} → ${next.recordCount} (${delta > 0 ? '+' : ''}${delta})`,
    });
  }

  // Guarded on `next.service` for the same reason the field comparison is: a probe that did not read
  // a descriptor reports *nothing* about the licence, and treating that silence as "the agency
  // withdrew its copyright" would raise a false licence alarm on every file-source check.
  const prevCredit = prev.service?.copyrightText;
  const nextCredit = next.service?.copyrightText;
  if (next.service && prevCredit !== nextCredit && (prevCredit || nextCredit)) {
    findings.push({
      severity: 'notable',
      message: `copyright text changed: ${prevCredit ?? '(none)'} → ${nextCredit ?? '(none)'} — the rendered credit may no longer match the terms`,
    });
  }

  if (next.http && prev.http) {
    const validatorMoved =
      (next.http.etag !== undefined && next.http.etag !== prev.http.etag) ||
      (next.http.lastModified !== undefined && next.http.lastModified !== prev.http.lastModified) ||
      (next.http.contentLength !== undefined &&
        next.http.contentLength !== prev.http.contentLength);
    if (validatorMoved) {
      findings.push({
        severity: findings.length > 0 ? 'cosmetic' : 'notable',
        message: `HTTP validators moved (etag/last-modified/length) — the file was republished`,
      });
    }
  }

  return { changed: findings.length > 0, findings };
}

/** The worst severity present, or `undefined` for a clean report. Drives the `verify` exit code. */
export function worstSeverity(report: DriftReport): DriftSeverity | undefined {
  if (report.findings.some((f) => f.severity === 'breaking')) return 'breaking';
  if (report.findings.some((f) => f.severity === 'notable')) return 'notable';
  if (report.findings.some((f) => f.severity === 'cosmetic')) return 'cosmetic';
  return undefined;
}
