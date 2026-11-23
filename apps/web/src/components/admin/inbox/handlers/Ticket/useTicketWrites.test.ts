import { describe, expect, it } from 'vitest';

import { TICKET_WORDS as W } from './ticketWords';
import { replyReceipt } from './useTicketWrites';

/**
 * **A reply's receipt is what the write answered** (B01-5f review): a reply the server stored as not
 * sent says so and why — never that it is on its way —, a send that stopped before saying how it went
 * says neither sent nor not sent, and a repeat press answers the reply as it now stands.
 */
describe('a reply’s receipt, from its answer', () => {
  it('a settling reply: the queued words', () => {
    expect(replyReceipt({ status: 'settling', failedWhy: null })).toEqual({
      title: W.replyQueued,
      description: W.replyQueuedDetail,
    });
  });

  it('a reply the server won’t send: saved, not sent, and why', () => {
    expect(replyReceipt({ status: 'failed', failedWhy: 'seed' })).toEqual({
      title: 'Reply saved, not sent',
      description: `It won’t be emailed: ${W.notSentWhy.seed}`,
    });
    expect(replyReceipt({ status: 'failed', failedWhy: 'unconfigured' }).description).toContain(
      'no sending address or email service is set up',
    );
    expect(replyReceipt({ status: 'failed', failedWhy: null }).description).toContain(
      W.notSentUnknown,
    );
  });

  it('a send whose outcome is unknown: neither sent nor not sent', () => {
    const r = replyReceipt({ status: 'failed', failedWhy: 'outcomeUnknown' });
    expect(r.title).toBe('Sending stopped · it may or may not have been sent');
    expect(r.title).not.toMatch(/^(Sent|Not sent|Reply saved, not sent)/);
  });

  it('a repeat press: the reply as it stands — sent only when the server says sent', () => {
    expect(replyReceipt({ status: 'sent', failedWhy: null }).title).toBe('Sent');
    expect(replyReceipt({ status: 'canceled', failedWhy: null }).title).toBe('Reply canceled');
  });
});
