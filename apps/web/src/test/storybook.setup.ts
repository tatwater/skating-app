import { configure } from 'storybook/test';
import { beforeEach } from 'vitest';
import { commands, userEvent } from 'vitest/browser';

import type { RealPointer } from '../components/kit/storyKit';

declare module 'vitest/browser' {
  interface BrowserCommands {
    /** Move the real pointer off the page (`pointer.commands.ts`). */
    parkPointer: () => Promise<void>;
  }
}

/**
 * A play function's `findBy*` and `waitFor` wait 5 s, not Testing Library's 1 s: the CI runner is
 * frame-starved, and a fade, an opening focus or a cold image has outrun 1 s there while settling
 * in a frame or two locally. Only a wait that would pass gets longer; one that never passes still
 * fails, inside the 20 s test cap (`vitest.config.ts`).
 */
configure({ asyncUtilTimeout: 5_000 });

/**
 * Story tests (the `storybook` project) start with the real pointer off the page. See
 * `pointer.commands.ts` for why: without this, Linux Chromium renders a story's first control
 * hovered, because Playwright's mouse rests at (0, 0) where that control sits.
 */
beforeEach(async () => {
  await commands.parkPointer();
  // A park that didn't take fails here, by name, not as a stray hover color three files later.
  const hovered = document.querySelector(':hover');
  if (hovered !== null) {
    throw new Error(`The pointer is still over <${hovered.localName}> after parking it.`);
  }
});

/**
 * The real pointer, for the few stories that test CSS `:hover` itself. (`storybook/test`'s
 * `userEvent.hover` dispatches events, which never match `:hover`.) Stories reach it through
 * `realPointer()` in `storyKit`, so no story file imports Vitest.
 */
const pointer: RealPointer = {
  hover: (el) => userEvent.hover(el),
  park: () => commands.parkPointer(),
};
globalThis.__kitRealPointer = pointer;
