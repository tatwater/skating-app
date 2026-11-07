import * as tokens from '@skating/design/tokens';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { Button } from './button';
import { computedColor, contentRect, JUNCTION_TOLERANCE_PX, resolvePx } from './measure';
import { Section, SectionSlug } from './section-slug';
import { KICKER, must, rootPx } from './storyKit';

const meta = {
  title: 'Kit/Section slug',
  component: SectionSlug,
  tags: ['autodocs'],
  args: { title: 'Outline' },
  decorators: [(Story) => <div className="w-full max-w-[24rem]">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'The section title: an inverted kicker chip, a hairline to the row end, and what ends it — the **count** for a section that lists things (`0` when empty), a legend or link, or the square terminal on a bare rule. A heading sits **exactly 12 px over its content**, chip to content, whatever the content is: the junction stories measure it against bare text, a trimmed paragraph and a padded bare button.',
      },
    },
  },
} satisfies Meta<typeof SectionSlug>;

export default meta;
type Story = StoryObj<typeof meta>;

const part = (root: ParentNode, slot: string) =>
  must(root.querySelector<HTMLElement>(`[data-slot="${slot}"]`));

/** The `::after` of the rule: the square terminal, if it is drawn. */
const terminalOf = (rule: HTMLElement) => getComputedStyle(rule, '::after');

// ── The slug and what ends its rule ──────────────────────────────────────────────────────────

/**
 * A bare rule — a comparison, a choice — keeps the square terminal: 4 px, centered on the hairline
 * at its end. The chip is the field's ink inverted, square, in kicker caps.
 */
export const Terminal: Story = {
  play: async ({ canvasElement }) => {
    const heading = within(canvasElement).getByRole('heading', { level: 2, name: 'Outline' });
    const chip = part(canvasElement, 'section-chip');
    await expect(chip).toBe(heading);
    const style = getComputedStyle(chip);
    await expect(style.textTransform).toBe('uppercase');
    await expect(style.backgroundColor).toBe(computedColor(chip, 'var(--fg1)'));
    await expect(style.color).toBe(computedColor(chip, 'var(--bg)'));
    await expect(style.borderRadius).toBe('0px');
    // The chip is 1.7 of its kicker step tall: the mocks' 4 + 10 + 3 px at the admin step.
    const kick = resolvePx(chip, 'var(--type-kick)');
    await expect(chip.getBoundingClientRect().height).toBeCloseTo(kick * 1.7, 1);

    const rule = part(canvasElement, 'section-rule');
    await expect(rule).toHaveAttribute('aria-hidden', 'true');
    await expect(rule.getBoundingClientRect().height).toBe(1);
    await expect(getComputedStyle(rule).backgroundColor).toBe(computedColor(rule, 'var(--line2)'));
    const square = terminalOf(rule);
    await expect(square.content).toBe('""');
    await expect(square.width).toBe('4px');
    await expect(square.height).toBe('4px');
    await expect(square.backgroundColor).toBe(computedColor(rule, 'var(--fg2)'));
    // The rule runs to the row's end.
    const row = part(canvasElement, 'section-slug').getBoundingClientRect();
    await expect(Math.abs(rule.getBoundingClientRect().right - row.right)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
    await expect(canvasElement.querySelector('[data-slot="section-end"]')).toBeNull();
  },
};

/** A section that lists things ends its rule in its count, in place of the square. */
export const Count: Story = {
  args: { title: 'Asked of this body', count: 3 },
  play: async ({ canvasElement }) => {
    const rule = part(canvasElement, 'section-rule');
    await expect(rule).not.toHaveAttribute('data-terminal');
    await expect(terminalOf(rule).content).toBe('none');
    const count = part(canvasElement, 'section-count');
    await expect(count).toHaveTextContent(/^3$/);
    await expect(getComputedStyle(count).fontFamily).toMatch(/Martian Mono/);
    await expect(getComputedStyle(count).color).toBe(computedColor(count, 'var(--fg2)'));
    // The count sits `space-2_5` after the rule's end and ends the row.
    const gap = count.getBoundingClientRect().left - rule.getBoundingClientRect().right;
    await expect(Math.abs(gap - resolvePx(rule, 'var(--space-2_5)'))).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
  },
};

/** An empty list still says it is one: `0`, never the bare square. */
export const CountZero: Story = {
  args: { title: 'Bays', count: 0 },
  play: async ({ canvasElement }) => {
    await expect(part(canvasElement, 'section-count')).toHaveTextContent(/^0$/);
    await expect(part(canvasElement, 'section-rule')).not.toHaveAttribute('data-terminal');
  },
};

/** A large count reads with its separator. */
export const CountLarge: Story = {
  args: { title: 'Every job', count: 12480 },
  play: async ({ canvasElement }) => {
    await expect(part(canvasElement, 'section-count')).toHaveTextContent(/^12,480$/);
  },
};

/**
 * A link at the rule's end (the section's own page) ends the rule too. It is taller than the chip,
 * but the row isn't: the end hangs centered on the row, so the heading gap stays the chip's.
 */
export const LinkAtTheEnd: Story = {
  render: () => (
    <Section
      title="Enrichment"
      end={
        <Button variant="link" size="xs">
          Enrichment
        </Button>
      }
    >
      <p className="text-row leading-none text-fg2">Every source on file</p>
    </Section>
  ),
  play: async ({ canvasElement }) => {
    const chip = part(canvasElement, 'section-chip').getBoundingClientRect();
    const row = part(canvasElement, 'section-slug').getBoundingClientRect();
    const link = within(canvasElement).getByRole('button', { name: /Enrichment/ });
    await expect(link.getBoundingClientRect().height).toBeGreaterThan(chip.height);
    await expect(Math.abs(row.height - chip.height)).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // Centered on the chip's midline.
    const mid = (r: DOMRect) => r.top + r.height / 2;
    await expect(Math.abs(mid(link.getBoundingClientRect()) - mid(chip))).toBeLessThanOrEqual(0.5);
    await expect(terminalOf(part(canvasElement, 'section-rule')).content).toBe('none');
  },
};

/** The level is the caller's; the section region is named by its heading. */
export const Levels: Story = {
  render: () => (
    <div className="flex flex-col gap-(--space-6)">
      <Section title="History" level={3} count={31}>
        <p className="text-row leading-none text-fg2">Rate updated</p>
      </Section>
      <SectionSlug title="Standing" level={4} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 3, name: 'History' })).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 4, name: 'Standing' })).toBeVisible();
    await expect(canvas.getByRole('region', { name: 'History' })).toBeVisible();
  },
};

/** A long title truncates at phone width rather than pushing the rule off the row. */
export const LongTitle: Story = {
  args: { title: 'Every body that touches, overlaps or nearly touches this one', count: 4 },
  decorators: [(Story) => <div className="w-[14rem]">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const row = part(canvasElement, 'section-slug');
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    const rule = part(canvasElement, 'section-rule').getBoundingClientRect();
    await expect(rule.width).toBeGreaterThanOrEqual(resolvePx(row, '1.5rem') - 0.5);
  },
};

// ── Junctions: the heading gap, chip to content ──────────────────────────────────────────────

/** Three sections, three kinds of content; each sits the heading gap under its chip. */
function HeadingGap() {
  return (
    <div className="flex flex-col gap-(--space-8)">
      <Section title="Outline" data-junction="text">
        <p className="text-row leading-none text-fg2">The shore and 3 islands</p>
      </Section>
      <Section title="Notes" data-junction="trimmed">
        <p className="text-trim text-row leading-body text-fg2">
          The bay was redrawn on the west shore. The older outline is kept in History.
        </p>
      </Section>
      <Section title="Bays" count={2} data-junction="bleed">
        <Button variant="bare">Mascoma North</Button>
        <Button variant="bare">Mascoma South</Button>
      </Section>
    </div>
  );
}

async function playHeadingGap({
  canvasElement,
  globals,
}: {
  canvasElement: HTMLElement;
  globals: Record<string, unknown>;
}) {
  const surface = globals.surface as tokens.Surface;
  const gap = resolvePx(canvasElement, 'var(--gap-heading)');
  // The standing rule: 12 px at the 16 px base, on both surfaces.
  await expect(gap).toBeCloseTo(tokens.gap[surface].heading.value * rootPx(), 2);
  await expect(gap).toBeCloseTo(12 * (rootPx() / 16), 2);

  const sections = ['text', 'trimmed', 'bleed'].map((j) =>
    must(canvasElement.querySelector<HTMLElement>(`[data-junction="${j}"]`)),
  );
  for (const section of sections) {
    const chip = part(section, 'section-chip').getBoundingClientRect();
    const content = must(section.children[1]);
    const gapPx = contentRect(content).top - chip.bottom;
    await expect(
      Math.abs(gapPx - gap),
      `${section.dataset.junction}: chip → content`,
    ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
    // Content starts on the chip's left edge.
    await expect(Math.abs(contentRect(content).left - chip.left)).toBeLessThanOrEqual(
      JUNCTION_TOLERANCE_PX,
    );
  }

  // Not a cheat — the trimmed paragraph really is trimmed: two lines, shorter than two line boxes.
  const para = must(sections[1]?.querySelector('p'));
  const lineBox = resolvePx(para, '1lh');
  await expect(para.getBoundingClientRect().height).toBeLessThan(2 * lineBox - 1);
  // …and the bare button really carries its hit pad: its wash starts above the label.
  const button = must(sections[2]?.querySelector<HTMLElement>('[data-slot="button"]'));
  const hitY = resolvePx(button, 'var(--gap-hit-y)');
  await expect(contentRect(button).top - button.getBoundingClientRect().top).toBeCloseTo(hitY, 1);
}

/** Chip → bare text, chip → trimmed paragraph, chip → padded bare row: all the heading gap. Admin. */
export const JunctionAdmin: Story = {
  render: () => <HeadingGap />,
  globals: { surface: 'admin' },
  play: playHeadingGap,
};

/** The same junctions on skater: a larger hit pad, the same 12 px. */
export const JunctionSkater: Story = {
  render: () => <HeadingGap />,
  globals: { surface: 'skater' },
  play: playHeadingGap,
};

// ── Board and four-up ────────────────────────────────────────────────────────────────────────

function Board() {
  return (
    <div className="flex w-full max-w-[22rem] flex-col gap-(--space-6)">
      <Section title="Asked of this body" count={3}>
        <p className="text-trim text-row leading-list text-fg2">
          Public access · Posted rules · Bays
        </p>
      </Section>
      <Section title="Bays" count={0}>
        <p className="text-trim text-row leading-list text-fg3">Nothing drawn yet</p>
      </Section>
      <Section title="Standing">
        <p className="text-trim text-row leading-list text-fg2">Known · Read-only</p>
      </Section>
      <div className="flex flex-col gap-heading">
        <span className={KICKER}>A link at the end</span>
        <SectionSlug
          title="Enrichment"
          end={
            <Button variant="link" size="xs">
              Enrichment
            </Button>
          }
        />
      </div>
    </div>
  );
}

/** Every ending, in all four maps; the gap is the same 12 px on both surfaces. */
export const FourUp: Story = {
  render: () => <Board />,
  parameters: { fourUp: true },
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    const chips = new Set<number>();
    for (const q of quads) {
      const gap = resolvePx(q, 'var(--gap-heading)');
      for (const section of q.querySelectorAll<HTMLElement>('[data-slot="section"]')) {
        const chip = part(section, 'section-chip').getBoundingClientRect();
        const content = must(section.children[1]);
        await expect(
          Math.abs(content.getBoundingClientRect().top - chip.bottom - gap),
        ).toBeLessThanOrEqual(JUNCTION_TOLERANCE_PX);
      }
      chips.add(part(q, 'section-chip').getBoundingClientRect().height);
    }
    // The chip follows its surface's kicker step: shorter on the console.
    await expect(chips.size).toBe(2);
  },
};
