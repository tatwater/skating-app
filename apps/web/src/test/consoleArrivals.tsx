import { screen, waitFor } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { expect } from 'vitest';
import { BodyConsoleView } from '@/components/admin/body/frame/BodyConsoleView';
import {
  BODY_NOW,
  MASCOMA_ASKS,
  MASCOMA_COMPLETENESS,
  MASCOMA_HISTORY_ENTRIES,
  MASCOMA_IDENTITY,
  MASCOMA_TOWNS,
  MASCOMA_TRUST,
} from '@/components/admin/body/frame/bodyFixtures';
import { attentionTabs } from '@/components/admin/body/frame/bodyModel';
import { KeysProvider } from '@/lib/keys';

/**
 * A tab inside the console as the app frames it — the left column with its asks, the inspector's
 * tab strip, the tab in the panel — so a test can reach the tab every way an operator does and
 * press one of its keys (`ARRIVALS`).
 */
export function InConsole({ panel, bodyKey = 'k1' }: { panel: ReactNode; bodyKey?: string }) {
  return (
    <KeysProvider>
      <BodyConsoleView
        bodyKey={bodyKey}
        identity={MASCOMA_IDENTITY}
        completeness={MASCOMA_COMPLETENESS}
        towns={MASCOMA_TOWNS}
        trust={MASCOMA_TRUST}
        asks={MASCOMA_ASKS}
        history={MASCOMA_HISTORY_ENTRIES}
        lit={null}
        now={BODY_NOW}
        tab="shape"
        onTabChange={() => {}}
        onOpenAsk={() => {}}
        attention={attentionTabs(MASCOMA_COMPLETENESS.missing)}
        tabPanel={panel}
        map={<div>map</div>}
      />
    </KeysProvider>
  );
}

type User = ReturnType<typeof userEvent.setup>;

/** Each way a tab is reached, leaving focus where that way leaves it. */
export const ARRIVALS: [string, (user: User) => Promise<void>][] = [
  // The list's Open and a deep link both mount the console with nothing focused.
  ['the list’s Open or a deep link', async () => {}],
  ['a press on the tab strip', (user) => user.click(screen.getByRole('tab', { name: /Names/ }))],
  [
    'the tab strip’s arrows',
    async (user) => {
      screen.getByRole('tab', { name: /Shape/ }).focus();
      await user.keyboard('{ArrowRight}');
    },
  ],
  [
    'an ask',
    async (user) => {
      screen.getByRole('listbox', { name: 'Asked of this body' }).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.getByRole('tabpanel')).toHaveFocus());
    },
  ],
];
