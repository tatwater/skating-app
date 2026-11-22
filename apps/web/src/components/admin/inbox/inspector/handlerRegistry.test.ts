import { describe, expect, it } from 'vitest';

import { ACCESS_ITEM, ADMIT_ITEM, SAFETY_ITEM, TICKET_ITEM } from '../list/inboxFixtures';
import type { InboxItemView } from '../list/inboxTypes';
import {
  buildRegistry,
  HANDLERS,
  HandlerRegistryError,
  handlerKeyOf,
  type InboxHandler,
  registeredHandler,
} from './handlerRegistry';

const A: InboxHandler = () => null;
const B: InboxHandler = () => null;

describe('the handler registry', () => {
  it('keys a flag by its subject and every other item by its kind', () => {
    expect(handlerKeyOf(SAFETY_ITEM)).toBe('flag:report');
    expect(handlerKeyOf(ACCESS_ITEM)).toBe('access');
    expect(handlerKeyOf(ADMIT_ITEM)).toBe('request');
    expect(handlerKeyOf(TICKET_ITEM)).toBe('ticket');
    const onPerson = {
      ...SAFETY_ITEM,
      target: { targetType: 'user', targetId: 'u', exists: false },
    } as InboxItemView;
    expect(handlerKeyOf(onPerson)).toBe('flag:user');
  });

  it('takes one registration or several from each module', () => {
    const registry = buildRegistry({
      '../handlers/Access/register.ts': { registration: { keys: ['access'], Handler: A } },
      '../handlers/Flag/register.tsx': {
        registrations: [
          { keys: ['flag:report', 'flag:post'], Handler: B },
          { keys: ['flag:comment'], Handler: A },
        ],
      },
      '../handlers/Empty/register.ts': {},
    });
    expect([...registry.keys()].sort()).toEqual(
      ['access', 'flag:comment', 'flag:post', 'flag:report'].sort(),
    );
    expect(registeredHandler(ACCESS_ITEM, registry)).toBe(A);
    expect(registeredHandler(SAFETY_ITEM, registry)).toBe(B);
    // A kind nobody claims draws the placeholder (the caller's fallback).
    expect(registeredHandler(TICKET_ITEM, registry)).toBeUndefined();
  });

  it('refuses two handlers for one key, naming both', () => {
    expect(() =>
      buildRegistry({
        '../handlers/Flag/register.ts': { registration: { keys: ['flag:report'], Handler: A } },
        '../handlers/Other/register.ts': { registration: { keys: ['flag:report'], Handler: B } },
      }),
    ).toThrow(HandlerRegistryError);
    expect(() =>
      buildRegistry({
        '../handlers/Flag/register.ts': {
          registrations: [
            { keys: ['access'], Handler: A },
            { keys: ['access'], Handler: B },
          ],
        },
      }),
    ).toThrow(/Two Inbox handlers claim "access"/);
  });

  it('builds the real registry from the handlers on disk without a clash', () => {
    // However many handlers have landed, each key has exactly one.
    expect(HANDLERS).toBeInstanceOf(Map);
    for (const key of HANDLERS.keys()) expect(typeof key).toBe('string');
  });
});
