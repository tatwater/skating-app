/**
 * The ALSC parser, against the markup the live site actually served (N7-2, 2026-08-08).
 *
 * The fixtures below are trimmed from real responses, not invented — including the nested `<ul>`
 * with `style="list-style-type:none"`, the `<sup>` inside a label, the HTML entities in the
 * coordinates, and the blank-value fields. This is a 2005-era template being scraped without a
 * contract, so the tests are the contract.
 */

import { describe, expect, it } from 'vitest';
import {
  ALSC_BASE,
  ALSC_COUNTIES,
  type AlscOutcome,
  type AlscPond,
  alscCountyUrl,
  alscPondUrl,
  corroborate,
  fieldValue,
  MAX_PLAUSIBLE_ALSC_DEPTH_M,
  parseAlscReport,
  parseDms,
  parsePondList,
  textOf,
} from './alsc';

/** Aluminum Pond (060315), Hamilton County — verbatim from the live report. */
const REPORT = `
<div id="historic_report_location"><ul>
  <li style="list-style-type:none"><strong>Location/General</strong></li><ul>
    <li style="list-style-type:none">Pond Name: ALUMINUM POND</li>
    <li style="list-style-type:none">Pond #: 060315</li>
    <li style="list-style-type:none">Town: Lake Pleasant</li>
    <li style="list-style-type:none">County: Hamilton</li>
  </ul></ul></div>
<div id="historic_report_morpho"><ul>
  <li style="list-style-type:none"><strong>Morphometrics</strong></li><ul>
    <li style="list-style-type:none">Latitude (DD&deg;MM'SS&quot;): 43&deg;46'08&quot; N</li>
    <li style="list-style-type:none">Longitude (DD&deg;MM'SS&quot;): 074&deg;31'42&quot; W</li>
    <li style="list-style-type:none">Elevation (m): 739</li>
    <li style="list-style-type:none">Surface Area (ha): 3.2</li>
    <li style="list-style-type:none">Volume(m<sup>3</sup>): 24264</li>
    <li style="list-style-type:none">Shoreline Length (km): 0.7</li>
    <li style="list-style-type:none">%Shore Slope &gt;5deg: 99</li>
    <li style="list-style-type:none">Max Depth (m): 1.2</li>
    <li style="list-style-type:none">Mean Depth (m): 0.7</li>
  </ul></ul></div>`;

const pondOf = (outcome: AlscOutcome): AlscPond => {
  if (!outcome.ok) throw new Error(`expected a pond, got ${outcome.reason}`);
  return outcome.pond;
};

describe('parseAlscReport', () => {
  it('reads Aluminum Pond exactly as the site publishes it', () => {
    const pond = pondOf(parseAlscReport(REPORT, '060315'));
    expect(pond).toMatchObject({
      pondNumber: '060315',
      name: 'ALUMINUM POND',
      county: 'Hamilton',
      town: 'Lake Pleasant',
      elevationM: 739,
      surfaceAreaHa: 3.2,
      maxDepthM: 1.2,
      meanDepthM: 0.7,
      shorelineKm: 0.7,
      volumeM3: 24_264,
    });
    // Hamilton County, in the Adirondack Park — the sign on the longitude is the whole test.
    expect(pond.lat).toBeCloseTo(43.7689, 3);
    expect(pond.lng).toBeCloseTo(-74.5283, 3);
  });

  it('refuses a report whose pond number is not the one we asked for', () => {
    // The site echoes the pond it actually served. Keying that under the number we requested is how
    // a real depth lands on the wrong lake — the one failure here that looks like success.
    expect(parseAlscReport(REPORT, '999999')).toEqual({ ok: false, reason: 'not-a-report' });
  });

  it('calls an error page not-a-report rather than throwing on it', () => {
    expect(parseAlscReport('<html><body>404</body></html>')).toEqual({
      ok: false,
      reason: 'not-a-report',
    });
  });

  it('counts a sounded-but-not-measured pond as no-depth, which is a real state', () => {
    // The survey visited more ponds than it sounded; a blank depth is data, not a failure.
    const blank = REPORT.replace('Max Depth (m): 1.2', 'Max Depth (m): ').replace(
      'Mean Depth (m): 0.7',
      'Mean Depth (m): ',
    );
    expect(parseAlscReport(blank)).toEqual({ ok: false, reason: 'no-depth' });
  });

  it('refuses a mean deeper than the max, because that is the fields read across each other', () => {
    // Arithmetically impossible, and the specific failure mode of a label-based parser: it produces
    // two plausible numbers in the wrong slots.
    const crossed = REPORT.replace('Mean Depth (m): 0.7', 'Mean Depth (m): 9.9');
    expect(parseAlscReport(crossed)).toEqual({ ok: false, reason: 'implausible' });
  });

  it('refuses a depth deeper than any water in the region', () => {
    // Lake George, the deepest Adirondack lake, is ~59 m; the bound is a units-error backstop.
    const wrong = REPORT.replace(
      'Max Depth (m): 1.2',
      `Max Depth (m): ${MAX_PLAUSIBLE_ALSC_DEPTH_M + 1}`,
    );
    expect(parseAlscReport(wrong)).toEqual({ ok: false, reason: 'implausible' });
  });

  it('refuses a zero or negative depth rather than storing a lake with no water in it', () => {
    expect(parseAlscReport(REPORT.replace('Max Depth (m): 1.2', 'Max Depth (m): 0'))).toEqual({
      ok: false,
      reason: 'implausible',
    });
  });

  it('drops an elevation outside the regional window but keeps the pond', () => {
    // A bad elevation is not a reason to discard a measured depth; the fields are independent.
    const pond = pondOf(
      parseAlscReport(REPORT.replace('Elevation (m): 739', 'Elevation (m): 9999')),
    );
    expect(pond.elevationM).toBeUndefined();
    expect(pond.maxDepthM).toBe(1.2);
  });
});

describe('parseDms — the sign lives in the hemisphere letter', () => {
  it('reads a padded western longitude as negative', () => {
    // Degrees are published unsigned and zero-padded, so ignoring the letter puts every Adirondack
    // pond in Kazakhstan.
    expect(parseDms(`074°31'42" W`)).toBeCloseTo(-74.5283, 4);
    expect(parseDms(`43°46'08" N`)).toBeCloseTo(43.7689, 4);
  });

  it('handles southern and eastern hemispheres, so the rule is the letter and not the field', () => {
    expect(parseDms(`10°00'00" S`)).toBeCloseTo(-10, 6);
    expect(parseDms(`10°00'00" E`)).toBeCloseTo(10, 6);
  });

  it('returns undefined for anything it cannot read in full', () => {
    // A coordinate is the join key; a partial reading attaches a real depth to the wrong lake.
    expect(parseDms('')).toBeUndefined();
    expect(parseDms('43°46 N')).toBeUndefined();
    expect(parseDms('not a coordinate')).toBeUndefined();
  });
});

describe('textOf and fieldValue', () => {
  it('keeps one field per line, which is what makes a value with a colon readable', () => {
    expect(textOf('<li>A: 1</li><li>B: 2</li>')).toBe('A: 1\nB: 2');
  });

  it('strips a superscript out of a label rather than into the value', () => {
    // `Volume(m<sup>3</sup>)` must not read as a volume of 3.
    expect(fieldValue(textOf('<li>Volume(m<sup>3</sup>): 24264</li>'), 'Volume(m)')).toBe('24264');
  });

  it('treats a present-but-blank field as absent, never as zero', () => {
    // `Number('')` is 0, which would be a very confident wrong depth.
    expect(fieldValue(textOf('<li>Max Depth (m): </li>'), 'Max Depth (m)')).toBeUndefined();
  });

  it('does not let one field run into the next', () => {
    const text = textOf('<li>Max Depth (m): 1.2</li><li>Mean Depth (m): 0.7</li>');
    expect(fieldValue(text, 'Max Depth (m)')).toBe('1.2');
    expect(fieldValue(text, 'Mean Depth (m)')).toBe('0.7');
  });
});

describe('parsePondList', () => {
  const LISTING = `
    <a href="alscrpt.inc.php?alscpond=060315&pname=ALUMINUM POND">ALUMINUM POND</a>
    <a href="alscrpt.inc.php?alscpond=050636&amp;pname=BARKER POND">BARKER POND</a>
    <a href="alscrpt.inc.php?alscpond=060315&pname=ALUMINUM POND">dup on a county line</a>
    <a href="/index.shtml">not a pond</a>`;

  it('pulls pond numbers and names, and dedupes the county-line repeats', () => {
    // Enumerating by county is what turns 1,469 lookups into twelve — a pond on a boundary is
    // listed by both counties and must not be fetched twice.
    expect(parsePondList(LISTING)).toEqual([
      { pondNumber: '060315', name: 'ALUMINUM POND' },
      { pondNumber: '050636', name: 'BARKER POND' },
    ]);
  });

  it('covers the twelve counties the Adirondack Park spans', () => {
    expect(ALSC_COUNTIES).toHaveLength(12);
    expect(ALSC_COUNTIES).toContain('Hamilton');
    expect(ALSC_COUNTIES).toContain('St. Lawrence');
  });
});

describe('the two endpoints', () => {
  it('encodes a name with a space, which most pond names have', () => {
    const url = new URL(alscPondUrl('060315', 'ALUMINUM POND'));
    expect(url.searchParams.get('alscpond')).toBe('060315');
    expect(url.searchParams.get('pname')).toBe('ALUMINUM POND');
  });

  it('points the county lane at the form that enumerates, not at the one that reports', () => {
    // `fg_county.inc.php` is what makes this twelve requests instead of a 2,551-option `<select>`.
    expect(alscCountyUrl()).toBe(`${ALSC_BASE}/fg_county.inc.php`);
  });
});

describe('corroborate — the answer to a certificate that did not validate', () => {
  const pond = (pondNumber: string, surfaceAreaHa: number): AlscPond => ({
    pondNumber,
    name: `POND ${pondNumber}`,
    surfaceAreaHa,
    maxDepthM: 5,
  });

  it('scores agreement against polygons we drew from other publishers entirely', () => {
    // 3.2 ha = 32,000 m². Our own outline within tolerance is independent evidence the bytes are
    // the survey they claim to be, from sources that have never met.
    const known = new Map([['060315', { areaSqM: 31_000 }]]);
    expect(corroborate([pond('060315', 3.2)], known)).toMatchObject({
      comparable: 1,
      agreeing: 1,
      rate: 1,
    });
  });

  it('counts a wildly different area as a disagreement', () => {
    const known = new Map([['060315', { areaSqM: 5_000_000 }]]);
    expect(corroborate([pond('060315', 3.2)], known)).toMatchObject({ comparable: 1, agreeing: 0 });
  });

  it('excludes a pond we have no counterpart for rather than scoring it as agreement', () => {
    // The misleading-denominator shape: a pond the corpus lacks is not evidence either way, and
    // folding it in as agreement reports corroboration that was never measured.
    expect(corroborate([pond('999999', 3.2)], new Map())).toEqual({
      comparable: 0,
      agreeing: 0,
      rate: 0,
    });
  });

  it('ignores a pond with no published area, which cannot corroborate anything', () => {
    const known = new Map([['060315', { areaSqM: 31_000 }]]);
    expect(corroborate([{ pondNumber: '060315', name: 'X' }], known).comparable).toBe(0);
  });
});
