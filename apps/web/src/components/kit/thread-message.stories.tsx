import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { must } from './storyKit';
import { ThreadEvent, ThreadMessage } from './thread-message';

/**
 * A thread (board 2.8): a person's message, a staff note in the dashed box, a line between messages,
 * a reply with its status line, and someone gone drawn with a bare circle.
 */
function Thread() {
  return (
    <div className="flex max-w-[32rem] flex-col gap-(--space-4)">
      <ThreadMessage name="Rob Tremblay" face="Rob Tremblay" at="13 Oct 09:12">
        The suspension says my reports are false. I measured where I drilled.
      </ThreadMessage>
      <ThreadMessage name="Matt" face="Matt" kicker="Note · staff only" at="13 Oct 10:20" staff>
        A second flag on his 10 Oct report is still open in Safety.
      </ThreadMessage>
      <ThreadEvent>A note was removed</ThreadEvent>
      <ThreadMessage
        name="Teagan"
        face="Teagan"
        kicker="Reply by email"
        at="13 Oct 11:02"
        status={<span>Sending in 42 s</span>}
      >
        Thanks for writing.
      </ThreadMessage>
      <ThreadMessage name="A former skater" face={null} at="12 Oct 18:40">
        {`A long word that must wrap: ${'a'.repeat(120)}`}
      </ThreadMessage>
    </div>
  );
}

const meta = {
  title: 'Kit/ThreadMessage',
  component: Thread,
  parameters: { fourUp: true },
} satisfies Meta<typeof Thread>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourUp: Story = {
  play: async ({ canvasElement }) => {
    const quads = [...canvasElement.querySelectorAll<HTMLElement>('[data-theme-scope]')];
    await expect(quads).toHaveLength(4);
    for (const q of quads) {
      const messages = [...q.querySelectorAll<HTMLElement>('[data-thread-message]')];
      await expect(messages).toHaveLength(4);
      // The staff note alone is boxed, dashed.
      const staff = must(
        q.querySelector<HTMLElement>('[data-staff] [data-slot="thread-message-body"]'),
      );
      await expect(getComputedStyle(staff).borderTopStyle).toBe('dashed');
      const plain = must(
        messages[0]?.querySelector<HTMLElement>('[data-slot="thread-message-body"]'),
      );
      await expect(getComputedStyle(plain).borderTopWidth).toBe('0px');
      // Someone gone: a bare circle, no initials to read.
      const gone = must(
        messages[3]?.querySelector<HTMLElement>('[data-slot="thread-message-face"]'),
      );
      await expect(gone.textContent).toBe('');
      // A long run wraps inside its column, never past it.
      const body = must(
        messages[3]?.querySelector<HTMLElement>('[data-slot="thread-message-body"]'),
      );
      await expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
      await expect(q.querySelector('[data-slot="thread-event"]')).toHaveTextContent(
        'A note was removed',
      );
    }
  },
};
