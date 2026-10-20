import { NearbyApi } from '../link/nearbyTransport';

type Handler = (e: any) => void;

/**
 * 対称な2端末分の偽 Nearby(ペアリング用)。
 * - 両端末が advertise と discover を同時に行い、互いに onFound が届く
 * - requestConnect で両方に onInitiated(同じ確認コード)。両方が accept すると onConnected
 * - 片方が reject すると、両方に onFailed
 */
export function fakePairNet(digits = '4821') {
  type Side = NearbyApi & { name: string; advertising: boolean; discovering: boolean; accepted: boolean; emit(ev: string, e: any): void };
  let linked = false;
  let rejected = false;

  const make = (id: 'a' | 'b'): Side => {
    const h = new Map<string, Set<Handler>>();
    const peerId = id === 'a' ? 'b' : 'a';
    const side: Side = {
      name: '', advertising: false, discovering: false, accepted: false,
      emit: (ev, e) => h.get(ev)?.forEach((cb) => cb(e)),
      advertise(n) { side.name = n; side.advertising = true; find(); },
      discover() { side.discovering = true; find(); },
      requestConnect(_ep, myName) {
        queueMicrotask(() => {
          const me = sides[id], other = sides[peerId];
          me.emit('onInitiated', { endpointId: peerId, name: other.name, digits, incoming: false });
          other.emit('onInitiated', { endpointId: id, name: myName ?? me.name, digits, incoming: true });
        });
      },
      accept() {
        side.accepted = true;
        if (sides.a.accepted && sides.b.accepted && !linked && !rejected) {
          linked = true;
          queueMicrotask(() => {
            sides.a.emit('onConnected', { endpointId: 'b' });
            sides.b.emit('onConnected', { endpointId: 'a' });
          });
        }
      },
      reject() {
        rejected = true;
        queueMicrotask(() => {
          sides.a.emit('onFailed', { endpointId: 'b' });
          sides.b.emit('onFailed', { endpointId: 'a' });
        });
      },
      send(_ep, text) {
        if (!linked) return;
        queueMicrotask(() => sides[peerId].emit('onMessage', { endpointId: id, text }));
      },
      disconnect() {},
      stop() { side.advertising = false; side.discovering = false; },
      hmac: (s, d) => `${s}|${d}`,
      on(ev, cb) {
        if (!h.has(ev)) h.set(ev, new Set());
        h.get(ev)!.add(cb);
        return () => h.get(ev)!.delete(cb);
      },
    };
    return side;
  };

  const sides = { a: make('a'), b: make('b') };

  function find() {
    for (const [me, other] of [['a', 'b'], ['b', 'a']] as const) {
      if (sides[me].discovering && sides[other].advertising) {
        queueMicrotask(() => sides[me].emit('onFound', { endpointId: other, name: sides[other].name }));
      }
    }
  }

  return { a: sides.a, b: sides.b };
}
