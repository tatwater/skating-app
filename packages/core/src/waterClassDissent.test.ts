/**
 * The `classDissent` triage — which refusals our rules deliberately overrule (N7-2, 2026-08-08).
 *
 * Every token below appeared in the measured run's split, with the count it appeared at. The point
 * of the table is that a moderator opening the queue sees contradictions nobody has ruled on, rather
 * than 354 rows of our own rules working.
 */

import { describe, expect, it } from 'vitest';
import { refusalFamily, settledClassDissent } from './waterClass';

describe('refusalFamily', () => {
  it('reads moving water across all three catalogues’ vocabularies', () => {
    // The impoundment and deadwater case: a catalogue calls it a river, another calls it a lake, and
    // D96 already settles it in our favour — we carry 26 `river`-class bodies on purpose.
    // Measured: osm:water=river 109, 3dhp:featuretype=1 43, osm:water=stream 12.
    for (const token of [
      'osm:water=river', //      109 — the largest single pattern
      'osm:water=stream', //      12
      '3dhp:featuretype=1', //    43 — an opaque integer, named explicitly
      'osm:water=canal', //        1
      'nhd:ftype=46006', //            StreamRiver
      'osm:waterway=brook~', //        a loose read, and still flowing
    ]) {
      expect(refusalFamily(token)).toBe('flowing');
    }
  });

  it('reads built infrastructure, including NHD’s whole reservoir-purpose family', () => {
    // "NHD drops 43% of its reservoirs by FCODE" is the volume D96 warned would bury the queue.
    // Matched on the 436 prefix, because the purposes run to a dozen codes NHD extends between
    // releases — a new purpose code is the same finding as an existing one.
    for (const token of [
      'nhd:fcode=43612', //  21 — sewage treatment pond
      'nhd:fcode=43625', //   7
      'nhd:fcode=43624', //   8
      'nhd:fcode=43699', //       a purpose code that does not exist yet
      'osm:water=wastewater', // 23
      'osm:water=basin', //      18
      'osm:water=reflecting_pool', // 1
    ]) {
      expect(refusalFamily(token)).toBe('engineered');
    }
  });

  it('does NOT settle a salt claim, which is the whole point', () => {
    // These are explicit tidal assertions. They are settled by the elevation referee refusing them
    // (98 bodies), not by being outvoted — folding them in here would launder exactly what that
    // rule exists to catch.
    for (const token of ['osm:wetland=saltmarsh', 'osm:wetland=tidalflat', 'osm:water=salt_pool']) {
      expect(refusalFamily(token)).toBe('unsettled');
    }
  });

  it('leaves anything it has never seen unsettled, so a new source shape surfaces', () => {
    // `osm:natural=water` refusing at all was itself a surprise on the run (18 bodies). A token we
    // cannot explain belongs in front of a human, not in a settled bucket.
    expect(refusalFamily('osm:natural=water')).toBe('unsettled');
    expect(refusalFamily('3dhp:featuretype=99')).toBe('unsettled');
    expect(refusalFamily('nhd:ftype=445')).toBe('unsettled');
    expect(refusalFamily('')).toBe('unsettled');
  });
});

describe('settledClassDissent', () => {
  it('settles a group whose every refusal is a rule we overrule', () => {
    expect(settledClassDissent(['osm:water=river'])).toBe(true);
    expect(settledClassDissent(['osm:water=river', 'nhd:fcode=43612'])).toBe(true);
  });

  it('refuses to settle a group with ONE refusal it cannot explain', () => {
    // Every one, not any: answering the settled half of a group does not close the open half. The
    // same shape `settledWetlandDissent` uses, for the same reason.
    expect(settledClassDissent(['osm:water=river', 'osm:wetland=saltmarsh'])).toBe(false);
    expect(settledClassDissent(['nhd:fcode=43612', 'osm:natural=water'])).toBe(false);
  });

  it('is not a dissent at all when nothing refused', () => {
    expect(settledClassDissent([])).toBe(false);
  });
});
