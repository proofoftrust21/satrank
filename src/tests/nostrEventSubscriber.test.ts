// Phase 8.0 — NostrEventSubscriber : tests purs (dedup + dispatcher).
//
// On NE teste PAS la connexion réseau réelle (intégration end-to-end avec
// un vrai relay = test flaky + setup lourd). On teste l'invariant clé du
// subscriber : dedup events arrivés via N relais + dispatch correct au
// handler.
import { describe, it, expect } from 'vitest';
import { NostrEventSubscriber, type NostrEventLike } from '../nostr/nostrEventSubscriber';

function makeEvent(id: string, kind = 30784): NostrEventLike {
  return {
    id,
    pubkey: 'a'.repeat(64),
    kind,
    created_at: 1_700_000_000,
    tags: [['d', 'satrank-oracle-announcement']],
    content: '{}',
    sig: 's'.repeat(128),
  };
}

describe('NostrEventSubscriber dedup + dispatch', () => {
  it('dispatches each unique event exactly once even when delivered via N relays', async () => {
    const dispatched: NostrEventLike[] = [];
    const sub = new NostrEventSubscriber({
      label: 'test',
      relays: [],
      filters: [{ kinds: [30784] }],
      onEvent: async (event) => { dispatched.push(event); },
    });
    // Simulate the same event arriving via 3 relays.
    const event = makeEvent('event-id-1');
    // @ts-expect-error — accessing private for unit testing dedup
    sub['handleEvent'](event, 'wss://relay1');
    // @ts-expect-error — accessing private for unit testing dedup
    sub['handleEvent'](event, 'wss://relay2');
    // @ts-expect-error — accessing private for unit testing dedup
    sub['handleEvent'](event, 'wss://relay3');
    // Wait for async dispatch resolution.
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].id).toBe('event-id-1');
  });

  it('dispatches distinct events independently', async () => {
    const dispatched: NostrEventLike[] = [];
    const sub = new NostrEventSubscriber({
      label: 'test',
      relays: [],
      filters: [{ kinds: [30784] }],
      onEvent: async (event) => { dispatched.push(event); },
    });
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('a'), 'wss://r1');
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('b'), 'wss://r1');
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('c'), 'wss://r2');
    await new Promise((r) => setTimeout(r, 5));
    expect(dispatched.map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('swallows handler errors without crashing the subscriber', async () => {
    let dispatched = 0;
    const sub = new NostrEventSubscriber({
      label: 'test',
      relays: [],
      filters: [{ kinds: [30784] }],
      onEvent: async (event) => {
        dispatched += 1;
        if (event.id === 'broken') throw new Error('handler boom');
      },
    });
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('ok-1'), 'wss://r1');
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('broken'), 'wss://r1');
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('ok-2'), 'wss://r1');
    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toBe(3); // tous 3 ont été tentés
  });

  it('seenCount tracks unique event ids', async () => {
    const sub = new NostrEventSubscriber({
      label: 'test',
      relays: [],
      filters: [{ kinds: [30784] }],
      onEvent: async () => { /* noop */ },
    });
    expect(sub.seenCount).toBe(0);
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('a'), 'r');
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('a'), 'r'); // dup
    // @ts-expect-error — private dedup
    sub['handleEvent'](makeEvent('b'), 'r');
    expect(sub.seenCount).toBe(2);
  });

  it('stop() clears reconnect timers + active relays', () => {
    const sub = new NostrEventSubscriber({
      label: 'test',
      relays: [],
      filters: [{ kinds: [30784] }],
      onEvent: async () => { /* noop */ },
    });
    sub.stop();
    expect(sub.connectedRelayCount).toBe(0);
  });
});
