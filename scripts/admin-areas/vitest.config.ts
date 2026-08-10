import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 20s, not vitest's 5s default — see the note in `packages/convex/vitest.config.ts`. The
    // flaking set is load-dependent: turbo runs 11 packages at once and CI is ~8x slower than
    // local, so whichever test loses the race times out while being fast in isolation. A hang is
    // unbounded and still fails; this only stops green code reporting red.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      // Only files whose every remaining line is `ogr2ogr`, file I/O or a CLI shell. Mirrors the
      // water ETL's config, including its rule: **if a file holds a decision, extract the decision.**
      //
      // ✅ The warning this comment used to carry has been acted on (N7 audit, 2026-08-06).
      // `buildRegion.ts` was excluded as `ogr2ogr` glue while holding `nearRegion`, `needsClipping`,
      // `roundCoords`, the bleed box and the downstate county list — and that last one is not
      // scenery: `scripts/etl`'s merge reads `downstate-ny.geojson` as the D111 corpus cut, so a
      // county on or off that list adds or removes **water bodies**. Those rules now live in
      // `regionRules.ts` and are covered; what is left here is the turf/`ogr2ogr` pipeline.
      exclude: [
        'src/**/*.test.ts',
        'src/buildRegion.ts',
        'src/cli.ts',
        'src/fetchStates.ts',
        'src/load.ts',
        'src/tiger.ts',
        'src/types.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
