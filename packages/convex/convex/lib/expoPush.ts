/**
 * The Expo push transport (N8 PR 3) — the HTTP half of "push is a transport over the inbox" (D167).
 *
 * Expo's push service fronts APNs and FCM behind one endpoint, so the server never holds an Apple
 * key or a Firebase credential: those live in EAS and are used at build time to mint the device's
 * `ExponentPushToken[…]`. What this module sends is a message per token; what it reads back is a
 * **ticket** per message, and — later — a **receipt** per ticket, which is where the one error that
 * matters lives: `DeviceNotRegistered` means the address is dead and should be disabled, or Expo will
 * eventually stop delivering to *any* of our tokens for the noise.
 *
 * Kept as plain functions over `fetch` so the delivery action is testable with a stubbed transport
 * and the chunking rule is checkable without a network.
 */

const SEND_ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';

/** Expo accepts at most 100 messages per request and 1,000 receipt ids per request. */
export const PUSH_SEND_CHUNK = 100;
export const PUSH_RECEIPT_CHUNK = 1000;

export interface ExpoPushMessage {
  to: string;
  title: string;
  body?: string;
  /** Arbitrary JSON the app reads on tap — here, the notification id and its target. */
  data?: Record<string, unknown>;
  /** iOS collapse id / Android tag — a later message with the same id replaces the earlier one. */
  collapseId?: string;
  /** Android channel; the app creates `default` at startup. */
  channelId?: string;
  sound?: 'default' | null;
}

export type ExpoPushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export type ExpoPushReceipt =
  | { status: 'ok' }
  | { status: 'error'; message: string; details?: { error?: string } };

/** The one receipt/ticket error that means "stop sending to this token". */
export const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

export function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Send messages in Expo-sized chunks. Returns one ticket per message, in order. A chunk whose HTTP
 * call fails outright yields `error` tickets for every message in it rather than throwing — the
 * caller is a scheduled action that has already committed its rows, and a network blip must not
 * abort the rest of the batch.
 */
export async function sendExpoPush(
  messages: readonly ExpoPushMessage[],
  fetchImpl: typeof fetch = fetch,
): Promise<ExpoPushTicket[]> {
  const tickets: ExpoPushTicket[] = [];
  for (const batch of chunk(messages, PUSH_SEND_CHUNK)) {
    try {
      const res = await fetchImpl(SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
          ...(process.env.EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        const message = `Expo push send failed: ${res.status} ${res.statusText}`;
        console.warn(message);
        for (const _ of batch) tickets.push({ status: 'error', message });
        continue;
      }
      const json = (await res.json()) as { data?: ExpoPushTicket[] };
      const data = json.data ?? [];
      for (let i = 0; i < batch.length; i++) {
        tickets.push(data[i] ?? { status: 'error', message: 'No ticket returned' });
      }
    } catch (err) {
      const message = `Expo push send threw: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(message);
      for (const _ of batch) tickets.push({ status: 'error', message });
    }
  }
  return tickets;
}

/** Fetch receipts for ticket ids. Missing ids (not yet available) are simply absent from the map. */
export async function getExpoPushReceipts(
  ticketIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, ExpoPushReceipt>> {
  const receipts: Record<string, ExpoPushReceipt> = {};
  for (const batch of chunk(ticketIds, PUSH_RECEIPT_CHUNK)) {
    try {
      const res = await fetchImpl(RECEIPTS_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(process.env.EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({ ids: batch }),
      });
      if (!res.ok) {
        console.warn(`Expo push receipts failed: ${res.status} ${res.statusText}`);
        continue;
      }
      const json = (await res.json()) as { data?: Record<string, ExpoPushReceipt> };
      Object.assign(receipts, json.data ?? {});
    } catch (err) {
      console.warn('Expo push receipts threw', err);
    }
  }
  return receipts;
}

/** Whether a ticket or receipt says the token is dead. */
export function isDeviceNotRegistered(
  result: ExpoPushTicket | ExpoPushReceipt | undefined,
): boolean {
  return result?.status === 'error' && result.details?.error === DEVICE_NOT_REGISTERED;
}
