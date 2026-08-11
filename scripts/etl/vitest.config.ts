import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * 20s, not vitest's 5s default.
     *
     * **The flaking set is load-dependent, which is why per-test bounds could not fix it.** Three
     * different tests timed out across three consecutive full-suite runs — a 60-bay convex-test
     * import, a 140,000-point density probe, a union-find chain sized to the call stack — and none
     * of them is slow in isolation (0.3-0.5s). They lose the race only when turbo runs 11 packages
     * at once on a machine already doing something else, and CI is measured at ~8x slower than
     * local. Bounding whichever test happened to lose is chasing the symptom.
     *
     * This does not hide a hang: a hang is unbounded and still fails, 15 seconds later. What it
     * stops is a green suite reporting red for reasons that have nothing to do with the code.
     */
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // ## What may be excluded, and what may not
      //
      // **Only files whose every remaining line is `spawnSync`, file I/O or a CLI shell.** That was
      // an accurate description of `merge.ts` the day it was written and stopped being one the moment
      // it grew a merge rule — by the time the N7 audit reached it, an excluded file held the veto
      // set, the class precedence, the name union, a union-find, the region clip, the GNIS lane and
      // the bay rule, and decided all 27,074 rows untested.
      //
      // So the rule now is: **if a file holds a decision, extract the decision.** `mergeRules.ts`,
      // `extract.ts` and `gnisSource.ts` are what came out of the three worst offenders, and each is
      // at 100%. A file below stays excluded only while `git diff` on it is I/O.
      //
      // ⚠ Do not add to this list to make a build pass. Split the file instead.
      exclude: [
        'src/**/*.test.ts',
        // ── Command shells: argv parsing, subprocess spawning, file reads and a report ──
        'src/cli.ts',
        'src/load.ts', // batching + `convex run`; every decision is in the transform
        'src/loadDepths.ts',
        // osmium + ORS + file I/O. Every rule it applies — what counts as access, which lot serves
        // which launch, how an ORS response is read, what a fallback is flagged as — lives in
        // `accessTransform.ts` and `@skating/core`'s `access.ts`, both at full coverage. What is left
        // here is the subprocess, the response cache and the report.
        'src/accessCli.ts',
        'src/loadAccess.ts', // batching + `convex run`; the join and the ladder are in the mutation
        'src/loadSubAreas.ts', // reads the artifact, calls one mutation; the rules are both tested
        'src/loadReconciliation.ts',
        'src/resolveMergeDuplicates.ts', // reads the artifact, calls one mutation; the rules are tested
        'src/pruneFloor.ts', // drives `waterBodies.pruneBelowAreaFloor`, which has its own tests
        // Reads `absorbed.ndjson`, calls one mutation. Every rule that decides whether a row may be
        // retired — missing, already merged, self-pair, survivor absent — lives in
        // `waterBodies.retireAbsorbedBodies` and is tested there against those four cases.
        'src/retireAbsorbed.ts',
        // `main()` + `spawnSync` + the report. **The orchestration is no longer in here either**:
        // the second N7 audit found that the extraction to `mergeRules.ts` had stopped at the
        // *rules*, leaving the ORDER they run in — which is where every ordering bug in this phase
        // has lived — inside an excluded file. `masterList.ts` is that second extraction and is
        // covered end to end by `masterList.test.ts`. What is left here is archives in, artifacts
        // out, and a printed report.
        'src/merge.ts',
        // Read-only funnels and censuses. Every classification decision they report is made by
        // `@skating/core`'s `waterClass`, tested there against named real bodies.
        'src/auditArchives.ts',
        'src/bakeOff.ts',
        'src/refereeDuplicates.ts', // read-only census over the merge artifacts + the sounding export
        'src/tidalBand.ts', //          read-only census; D126's blast-radius check
        'src/classifyDryRun.ts',
        'src/measure3dhp.ts',
        'src/reconcileNhd.ts',
        // ── Fetchers: curl, sha256, unzip. Their constants and pure rules are extracted. ──
        'src/fetchExtract.ts',
        'src/fetch3dhp.ts',
        'src/fetchNhd.ts',
        'src/gnisArchive.ts', // constants + header rules live in `gnisSource.ts`, which IS covered
        'src/types.ts', // type-only
      ],
      // Matches @skating/core + @skating/convex; ratchet upward over time (D40).
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
