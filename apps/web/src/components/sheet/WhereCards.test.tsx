import type { Where } from '@skating/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ConsoleModeProvider, useConsoleMode } from './ConsoleMode';
import { type WhereCard, WhereCards } from './WhereCards';

/** What the instrument would read: the mode's label, so a click on the ring answers the right card. */
function ModeProbe() {
  const { mode } = useConsoleMode();
  return <output data-testid="mode">{mode?.kind === 'where' ? mode.label : 'none'}</output>;
}

function Harness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [active, setActive] = useState<string | null>(null);
  const [wheres, setWheres] = useState<Record<string, Where | undefined>>({
    'iceTypes:black_ice': { sector: 'N' },
    'surfaceTags:glass': undefined,
  });
  const cards: WhereCard[] = [
    {
      id: 'iceTypes:black_ice',
      label: 'Black ice',
      where: wheres['iceTypes:black_ice'],
      onChange: (w) => setWheres((s) => ({ ...s, 'iceTypes:black_ice': w })),
    },
    {
      id: 'surfaceTags:glass',
      label: 'Glass',
      where: wheres['surfaceTags:glass'],
      onChange: (w) => setWheres((s) => ({ ...s, 'surfaceTags:glass': w })),
    },
  ];
  return (
    <ConsoleModeProvider>
      <ModeProbe />
      <WhereCards
        cards={cards}
        body={null}
        open={open}
        onClose={() => setOpen(false)}
        activeId={active}
        onActivate={setActive}
      />
    </ConsoleModeProvider>
  );
}

describe('WhereCards', () => {
  it('opens on the first card, puts the console in where-mode for it, and marks the unanswered peer', () => {
    render(<Harness />);
    expect(screen.getByText('Where is the black ice?')).toBeInTheDocument();
    expect(screen.getByTestId('mode')).toHaveTextContent('Black ice');
    expect(screen.getByRole('tab', { name: /Glass/ })).toHaveTextContent('no answer yet');
    expect(screen.getByRole('tab', { name: /Black ice/ })).not.toHaveTextContent('no answer yet');
  });

  it('Skip moves to the next card, in any order; the mode follows', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByText('Where is the glass?')).toBeInTheDocument();
    expect(screen.getByTestId('mode')).toHaveTextContent('Glass');
    fireEvent.click(screen.getByRole('tab', { name: /Black ice/ }));
    expect(screen.getByTestId('mode')).toHaveTextContent('Black ice');
  });

  it('a sector chip answers the open card, and Done leaves the mode', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    fireEvent.click(screen.getByRole('button', { name: 'East side' }));
    expect(screen.getByRole('button', { name: '◆ East side' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Glass/ })).not.toHaveTextContent('no answer yet');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/Where is the/)).not.toBeInTheDocument();
    expect(screen.getByTestId('mode')).toHaveTextContent('none');
  });

  it('Escape leaves the mode from anywhere, and closes the question that opened it', () => {
    render(<Harness />);
    expect(screen.getByTestId('mode')).toHaveTextContent('Black ice');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('mode')).toHaveTextContent('none');
    expect(screen.queryByText(/Where is the/)).not.toBeInTheDocument();
  });
});

/**
 * The console's real shape: the parent reads the mode (as `Console` and `Instrument` do) and
 * rebuilds the cards — new `onChange` closures — on every render, as `IceAndSurface` does.
 */
function ConsoleShapedHarness() {
  const { mode } = useConsoleMode();
  const [wheres, setWheres] = useState<Record<string, Where | undefined>>({
    'iceTypes:black_ice': undefined,
  });
  const cards: WhereCard[] = [
    {
      id: 'iceTypes:black_ice',
      label: 'Black ice',
      where: wheres['iceTypes:black_ice'],
      onChange: (w) => setWheres((s) => ({ ...s, 'iceTypes:black_ice': w })),
    },
  ];
  return (
    <>
      <output data-testid="mode">{mode?.kind === 'where' ? mode.label : 'none'}</output>
      <WhereCards
        cards={cards}
        body={null}
        open
        onClose={() => {}}
        activeId={null}
        onActivate={() => {}}
      />
    </>
  );
}

describe('WhereCards inside a mode-reading parent', () => {
  it('settles: the mode is armed once, not on every render the arming itself causes', () => {
    render(
      <ConsoleModeProvider>
        <ConsoleShapedHarness />
      </ConsoleModeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('Black ice');
  });
});
