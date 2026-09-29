import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readJpegExif } from './jpegExif';

type Value =
  | { tag: number; ascii: string }
  | { tag: number; long: number }
  | { tag: number; rationals: [number, number][] };

/**
 * A minimal EXIF JPEG: SOI, one APP1 `Exif` segment holding a TIFF block with IFD0 and, when given,
 * the Exif and GPS sub-IFDs (their pointers filled in), then EOI. Either byte order.
 */
function jpeg(
  little: boolean,
  ifds: { ifd0?: Value[]; exif?: Value[]; gps?: Value[] },
  opts: { leadingApp0?: boolean } = {},
): Uint8Array {
  const buf: number[] = [];
  const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) =>
    little
      ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
      : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const at = (o: number, bytes: number[]) => {
    for (let k = 0; k < bytes.length; k++) buf[o + k] = bytes[k] as number;
  };
  const payload = (v: Value): { type: number; count: number; data: number[] } => {
    if ('ascii' in v) {
      const data = [...v.ascii].map((c) => c.charCodeAt(0)).concat(0);
      return { type: 2, count: data.length, data };
    }
    if ('long' in v) return { type: 4, count: 1, data: u32(v.long) };
    return {
      type: 5,
      count: v.rationals.length,
      data: v.rationals.flatMap(([n, d]) => [...u32(n), ...u32(d)]),
    };
  };
  const writeIfd = (start: number, values: Value[]): number => {
    let data = start + 2 + values.length * 12 + 4;
    at(start, u16(values.length));
    values.forEach((v, k) => {
      const e = start + 2 + k * 12;
      const p = payload(v);
      at(e, [...u16(v.tag), ...u16(p.type), ...u32(p.count)]);
      if (p.data.length <= 4) {
        at(e + 8, [...p.data, 0, 0, 0, 0].slice(0, 4));
      } else {
        at(e + 8, u32(data));
        at(data, p.data);
        data += p.data.length + (p.data.length % 2);
      }
    });
    at(start + 2 + values.length * 12, u32(0));
    return data;
  };
  // TIFF header, then IFD0 with pointer slots filled after the sub-IFDs are placed.
  at(0, [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8)]);
  const ifd0: Value[] = [...(ifds.ifd0 ?? [])];
  if (ifds.exif) ifd0.push({ tag: 0x8769, long: 0 });
  if (ifds.gps) ifd0.push({ tag: 0x8825, long: 0 });
  let next = writeIfd(8, ifd0);
  const patchPointer = (tag: number, to: number) => {
    const k = ifd0.findIndex((v) => v.tag === tag);
    at(8 + 2 + k * 12 + 8, u32(to));
  };
  if (ifds.exif) {
    patchPointer(0x8769, next);
    next = writeIfd(next, ifds.exif);
  }
  if (ifds.gps) {
    patchPointer(0x8825, next);
    next = writeIfd(next, ifds.gps);
  }
  const tiff = Array.from({ length: buf.length }, (_, k) => buf[k] ?? 0);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  const app0 = opts.leadingApp0 ? [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46] : [];
  return new Uint8Array([
    0xff,
    0xd8,
    ...app0,
    0xff,
    0xe1,
    len >> 8,
    len & 255,
    ...app1,
    0xff,
    0xd9,
  ]);
}

const FULL = {
  ifd0: [{ tag: 0x0132, ascii: '2026:01:10 15:00:00' }],
  exif: [
    { tag: 0x9003, ascii: '2026:01:10 14:10:07' },
    { tag: 0x9011, ascii: '-05:00' },
  ],
  gps: [
    { tag: 0x0001, ascii: 'N' },
    {
      tag: 0x0002,
      rationals: [
        [43, 1],
        [38, 1],
        [1800, 100],
      ] as [number, number][],
    },
    { tag: 0x0003, ascii: 'W' },
    {
      tag: 0x0004,
      rationals: [
        [72, 1],
        [8, 1],
        [0, 1],
      ] as [number, number][],
    },
  ],
};

describe('readJpegExif', () => {
  for (const little of [true, false]) {
    it(`reads the time and the fix (${little ? 'Intel' : 'Motorola'} byte order)`, () => {
      expect(readJpegExif(jpeg(little, FULL))).toEqual({
        DateTime: '2026:01:10 15:00:00',
        DateTimeOriginal: '2026:01:10 14:10:07',
        OffsetTimeOriginal: '-05:00',
        GPSLatitude: 43 + 38 / 60 + 18 / 3600,
        GPSLatitudeRef: 'N',
        GPSLongitude: 72 + 8 / 60,
        GPSLongitudeRef: 'W',
      });
    });
  }

  it('finds the Exif segment after another APP segment', () => {
    expect(readJpegExif(jpeg(true, FULL, { leadingApp0: true }))?.DateTimeOriginal).toBe(
      '2026:01:10 14:10:07',
    );
  });

  it('keeps a fix only whole — a latitude with no longitude is no fix', () => {
    const half = jpeg(true, { gps: [FULL.gps[0] as Value, FULL.gps[1] as Value] });
    expect(readJpegExif(half)).toEqual({});
  });

  it('refuses a zero denominator rather than dividing by it', () => {
    const bad = jpeg(true, {
      gps: [
        {
          tag: 0x0002,
          rationals: [
            [43, 0],
            [0, 1],
            [0, 1],
          ],
        },
        {
          tag: 0x0004,
          rationals: [
            [72, 1],
            [0, 1],
            [0, 1],
          ],
        },
      ],
    });
    expect(readJpegExif(bad)).toEqual({});
  });

  it('reads nothing from what is not an EXIF JPEG', () => {
    expect(readJpegExif(new Uint8Array([]))).toBeNull();
    expect(readJpegExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG
    expect(readJpegExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull(); // no APP1
  });

  it('reads nothing past a truncation, and never throws on any bytes', () => {
    const whole = jpeg(false, FULL);
    for (let cut = 0; cut < whole.length; cut += 7) {
      expect(() => readJpegExif(whole.slice(0, cut))).not.toThrow();
    }
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (tail) => {
        const bytes = new Uint8Array([
          0xff,
          0xd8,
          0xff,
          0xe1,
          0x01,
          0x00,
          0x45,
          0x78,
          0x69,
          0x66,
          0,
          0,
          ...tail,
        ]);
        const out = readJpegExif(bytes);
        expect(out === null || typeof out === 'object').toBe(true);
      }),
    );
  });
});
