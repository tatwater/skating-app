/**
 * A photo shared to Gli from another app (A10-8 §8.7) arrives as a bare file: no picker has read
 * its EXIF for us. This reads the few tags the sheet uses — the capture time and the GPS fix —
 * straight from a JPEG's APP1 segment, on device, before the re-encode strips everything (D31).
 * The output is the flat shape the image picker already hands the phone
 * (`{ DateTimeOriginal, OffsetTimeOriginal, GPSLatitude, GPSLatitudeRef, … }`), so the existing
 * readers (`exifCoord`, `exifTakenAt`) take it unchanged.
 *
 * Pure and defensive: every read is bounds-checked, so a truncated or hostile file yields `null`
 * or fewer tags, never a throw. JPEG only — a HEIC shared from an iPhone arrives with neither time
 * nor location, and is placed by hand like any other unlocated photo.
 */

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LNG_REF = 0x0003;
const TAG_GPS_LNG = 0x0004;

const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

/** How far into a file the reader looks: APP1 is capped at 64 KB and comes first. */
export const JPEG_EXIF_HEAD_BYTES = 256 * 1024;

interface Tiff {
  bytes: Uint8Array;
  /** Where the TIFF header starts — every offset in the block is relative to it. */
  base: number;
  little: boolean;
}

function u16(t: Tiff, at: number): number | null {
  const i = t.base + at;
  if (at < 0 || i + 2 > t.bytes.length) return null;
  const a = t.bytes[i] as number;
  const b = t.bytes[i + 1] as number;
  return t.little ? a | (b << 8) : (a << 8) | b;
}

function u32(t: Tiff, at: number): number | null {
  const i = t.base + at;
  if (at < 0 || i + 4 > t.bytes.length) return null;
  const b0 = t.bytes[i] as number;
  const b1 = t.bytes[i + 1] as number;
  const b2 = t.bytes[i + 2] as number;
  const b3 = t.bytes[i + 3] as number;
  return t.little
    ? (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
    : ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

interface Entry {
  type: number;
  count: number;
  /** Where the value lives: in the entry itself when it fits in four bytes, else at the offset. */
  valueAt: number;
}

/** An IFD's entries by tag. A malformed directory reads as empty. */
function readIfd(t: Tiff, at: number): Map<number, Entry> {
  const out = new Map<number, Entry>();
  const n = u16(t, at);
  if (n === null || n > 512) return out;
  for (let k = 0; k < n; k++) {
    const e = at + 2 + k * 12;
    const tag = u16(t, e);
    const type = u16(t, e + 2);
    const count = u32(t, e + 4);
    if (tag === null || type === null || count === null) break;
    const size = type === TYPE_RATIONAL ? 8 : type === TYPE_LONG ? 4 : type === 3 ? 2 : 1;
    const inline = size * count <= 4;
    const valueAt = inline ? e + 8 : u32(t, e + 8);
    if (valueAt === null) continue;
    out.set(tag, { type, count, valueAt });
  }
  return out;
}

function ascii(t: Tiff, e: Entry | undefined): string | undefined {
  if (!e || e.type !== TYPE_ASCII || e.count > 64) return undefined;
  let s = '';
  for (let k = 0; k < e.count; k++) {
    const i = t.base + e.valueAt + k;
    if (i >= t.bytes.length) return undefined;
    const c = t.bytes[i] as number;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim() || undefined;
}

function long(t: Tiff, e: Entry | undefined): number | null {
  if (!e || e.type !== TYPE_LONG || e.count !== 1) return null;
  return u32(t, e.valueAt);
}

/** Degrees, minutes, seconds as three rationals → decimal degrees. */
function degrees(t: Tiff, e: Entry | undefined): number | undefined {
  if (!e || e.type !== TYPE_RATIONAL || e.count !== 3) return undefined;
  const parts: number[] = [];
  for (let k = 0; k < 3; k++) {
    const num = u32(t, e.valueAt + k * 8);
    const den = u32(t, e.valueAt + k * 8 + 4);
    if (num === null || den === null || den === 0) return undefined;
    parts.push(num / den);
  }
  const [d, m, s] = parts as [number, number, number];
  const value = d + m / 60 + s / 3600;
  return Number.isFinite(value) ? value : undefined;
}

/** Find the TIFF block inside a JPEG's `Exif` APP1 segment, or `null`. */
function findTiff(bytes: Uint8Array): Tiff | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    // Start of scan or end of image: no metadata after this point.
    if (marker === 0xda || marker === 0xd9) return null;
    const len = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (len < 2) return null;
    if (marker === 0xe1 && i + 10 <= bytes.length) {
      const exif =
        bytes[i + 4] === 0x45 &&
        bytes[i + 5] === 0x78 &&
        bytes[i + 6] === 0x69 &&
        bytes[i + 7] === 0x66 &&
        bytes[i + 8] === 0 &&
        bytes[i + 9] === 0;
      if (exif) {
        const base = i + 10;
        if (base + 8 > bytes.length) return null;
        const order = String.fromCharCode(bytes[base] as number, bytes[base + 1] as number);
        if (order !== 'II' && order !== 'MM') return null;
        const t: Tiff = { bytes, base, little: order === 'II' };
        return u16(t, 2) === 42 ? t : null;
      }
    }
    i += 2 + len;
  }
  return null;
}

/**
 * The capture time and GPS tags of a JPEG, flat, or `null` when the file carries no EXIF. Only
 * tags that parse are present.
 */
export function readJpegExif(bytes: Uint8Array): Record<string, string | number> | null {
  const t = findTiff(bytes);
  if (!t) return null;
  const ifd0At = u32(t, 4);
  if (ifd0At === null) return null;
  const ifd0 = readIfd(t, ifd0At);
  const out: Record<string, string | number> = {};

  const dateTime = ascii(t, ifd0.get(TAG_DATETIME));
  if (dateTime) out.DateTime = dateTime;

  const exifAt = long(t, ifd0.get(TAG_EXIF_IFD));
  if (exifAt !== null) {
    const exif = readIfd(t, exifAt);
    const original = ascii(t, exif.get(TAG_DATETIME_ORIGINAL));
    const digitized = ascii(t, exif.get(TAG_DATETIME_DIGITIZED));
    const offset = ascii(t, exif.get(TAG_OFFSET_TIME_ORIGINAL));
    if (original) out.DateTimeOriginal = original;
    if (digitized) out.DateTimeDigitized = digitized;
    if (offset) out.OffsetTimeOriginal = offset;
  }

  const gpsAt = long(t, ifd0.get(TAG_GPS_IFD));
  if (gpsAt !== null) {
    const gps = readIfd(t, gpsAt);
    const lat = degrees(t, gps.get(TAG_GPS_LAT));
    const lng = degrees(t, gps.get(TAG_GPS_LNG));
    // A fix is both halves or neither.
    if (lat !== undefined && lng !== undefined) {
      out.GPSLatitude = lat;
      out.GPSLongitude = lng;
      const latRef = ascii(t, gps.get(TAG_GPS_LAT_REF));
      const lngRef = ascii(t, gps.get(TAG_GPS_LNG_REF));
      if (latRef) out.GPSLatitudeRef = latRef;
      if (lngRef) out.GPSLongitudeRef = lngRef;
    }
  }
  return out;
}
