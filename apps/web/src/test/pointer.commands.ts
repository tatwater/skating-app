/**
 * Story tests' real pointer, on the Node side of the Vitest browser runner (registered in
 * `vitest.config.ts`, called from `storybook.setup.ts`).
 *
 * Why it exists: a story renders with no padding under the runner, so its first control sits at the
 * page's (0, 0), right where Playwright's mouse starts. Chromium on Linux applies `:hover` (and
 * fires `pointerenter`) for an element that appears under a still cursor, so on CI a story's
 * first control rendered hovered, while on macOS it didn't. Storybook's Vitest addon has the same
 * reset, but it puts its setup file on the root config, which never reaches this project.
 */
/**
 * The part of Vitest's command context this uses, typed here rather than imported: importing
 * `vitest/node`'s types into the app's program reorders `@vitest/browser`'s jest-dom matchers
 * ahead of `@testing-library/jest-dom`'s and breaks `toHaveTextContent(/…/)` across the tests.
 */
type CommandContext = {
  provider: { name: string };
  page: { mouse: { move: (x: number, y: number) => Promise<void> } };
};

export const parkPointer = async (ctx: CommandContext): Promise<void> => {
  if (ctx.provider.name !== 'playwright') {
    throw new Error(`parkPointer drives Playwright's mouse; this run uses ${ctx.provider.name}.`);
  }
  // Well outside the page: no element is under it, so nothing is hovered.
  await ctx.page.mouse.move(-1000, -1000);
};
