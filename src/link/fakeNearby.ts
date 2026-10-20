import { NearbyApi } from './nearbyTransport';

type Handler = (e: any) => void;

/**
 * 2端末分の偽 Nearby。実機の挙動に寄せている:
 * - 広告と探索はどちらが先でも出会える(後から広告しても探索側に onFound が届く)
 * - stop() で広告・探索を止める
 * - drop() で明示切断、blackhole で「黙って届かなくなる」状態を作れる
 */
export function fakeNearbyPair() {
  type Side = NearbyApi & {
    name: string; directActive: boolean[]; advertising: boolean; discovering: boolean; endpoint: string | null;
    emit(ev: string, e: any): void; label: string;
  };
  let connected = false;
  let blackhole = false;

  const make = (name: string, label: 'H' | 'G'): Side => {
    const h = new Map<string, Set<Handler>>();
    const side: Side = {
      name, label, directActive: [], advertising: false, discovering: false, endpoint: null,
      emit: (ev, e) => h.get(ev)?.forEach((cb) => cb(e)),
      setDirectActive(on: boolean) { side.directActive.push(on); },
      advertise() { side.advertising = true; tryFind(); },
      discover() { side.discovering = true; tryFind(); },
      requestConnect() {
        queueMicrotask(() => {
          if (connected || !host.advertising) return;
          connected = true;
          guest.endpoint = 'H'; host.endpoint = 'G';
          guest.emit('onInitiated', { endpointId: 'H', name: host.name, incoming: false });
          host.emit('onInitiated', { endpointId: 'G', name: guest.name, incoming: true });
          guest.emit('onConnected', { endpointId: 'H' });
          host.emit('onConnected', { endpointId: 'G' });
        });
      },
      accept() {}, reject() {},
      send(_id, text) {
        if (!connected || blackhole) return;
        const to = side === host ? guest : host;
        queueMicrotask(() => connected && to.emit('onMessage', { endpointId: side === host ? 'H' : 'G', text }));
      },
      disconnect() { if (connected) drop(); },
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

  const host = make('DH-HOST', 'H');
  const guest = make('DH-GUEST', 'G');

  function tryFind() {
    if (host.advertising && guest.discovering && !connected) {
      queueMicrotask(() => guest.emit('onFound', { endpointId: 'H', name: host.name }));
    }
  }
  function drop() {
    if (!connected) return;
    connected = false;
    host.emit('onDisconnected', { endpointId: 'G' });
    guest.emit('onDisconnected', { endpointId: 'H' });
  }

  return {
    host, guest, drop,
    get connected() { return connected; },
    setBlackhole(v: boolean) { blackhole = v; },
  };
}
