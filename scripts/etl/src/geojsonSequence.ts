import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const RECORD_SEPARATOR = String.fromCharCode(0x1e);

type RecordResult<T> = { ok: true; feature: T } | { ok: false };

/**
 * Stream an osmium GeoJSON sequence without retaining its features. Accept an optional RFC 8142
 * record separator. Callers decide whether malformed JSON is counted or simply skipped; the reader
 * doesn't validate the feature's geometry or properties.
 */
export async function* readGeoJsonSequence<T>(file: string): AsyncGenerator<RecordResult<T>> {
  const input = createReadStream(file, 'utf8');
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of reader) {
      const trimmed = raw.trim();
      const line = trimmed.startsWith(RECORD_SEPARATOR) ? trimmed.slice(1) : trimmed;
      if (line.length === 0) continue;
      let record: RecordResult<T>;
      try {
        record = { ok: true, feature: JSON.parse(line) as T };
      } catch {
        record = { ok: false };
      }
      yield record;
    }
  } finally {
    reader.close();
    input.destroy();
  }
}
