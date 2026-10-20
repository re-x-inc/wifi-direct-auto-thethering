import test from 'node:test';
import assert from 'node:assert/strict';
import { NearbyApi, NearbyTransport } from './nearbyTransport';
import { Frame } from './supervisor';

/** 2端末を結ぶ偽の Nearby。host が広告し guest が見つけて接続する。 */
function fakeNet() {
  const side = (name: string) => {
    const h = new Map<string, Set<(e: any) => void>>();
    const emit = (ev: string, e: any) => h.get(ev)?.forEach((cb) => cb(e));
    const api: NearbyApi & { name: string; emit: typeof emit; peer?: any } = {
      name,
      emit,
      advertise() {},
      discover() { queueMicrotask(() => emit('onFound', { endpointId: 'H', name: api.peer.name })); },
      requestConnect(_id, myName) {
        queueMicrotask(() => {
          api.emit('onInitiated', { endpointId: 'H', name: api.peer.name, incoming: false });
          api.peer.emit('onInitiated', { endpointId: 'G', name: myName, incoming: true });
          api.emit('onConnected', { endpointId: 'H' });
          api.peer.emit('onConnected', { endpointId: 'G' });
        });
      },
      accept() {}, reject() {},
      send(_id, text) { const to = api.peer; queueMicrotask(() => to.emit('onMessage', { endpointId: to === hostApi ? 'G' : 'H', text })); },
      disconnect() {}, stop() {},
      hmac: (s, d) => `${s}|${d}`,
      on(ev, cb) { if (!h.has(ev)) h.set(ev, new Set()); h.get(ev)!.add(cb); return () => h.get(ev)!.delete(cb); },
    };
    return api;
  };
  const hostApi = side('HOST');
  const guestApi = side('GUEST');
  hostApi.peer = guestApi; guestApi.peer = hostApi;
  return { hostApi, guestApi };
}

const mk = (secretH: string, secretG: string) => {
  const { hostApi, guestApi } = fakeNet();
  const host = new NearbyTransport(hostApi, { role: 'host', selfId: 'HOST', pair: { peerId: 'GUEST', secret: secretH }, nonce: () => 'nh', connectTimeoutMs: 200 });
  const guest = new NearbyTransport(guestApi, { role: 'guest', selfId: 'GUEST', pair: { peerId: 'HOST', secret: secretG }, nonce: () => 'ng', connectTimeoutMs: 200 });
  return { host, guest };
};

test('同じ共有コードなら相互認証でき、Frame が届く', async () => {
  const { host, guest } = mk('s3cret', 's3cret');
  const got: Frame[] = [];
  host.onFrame((f) => got.push(f));
  await Promise.all([host.connect(), guest.connect()]);
  guest.send({ type: 'data', seq: 1, body: { yenPerKm: 230 } });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(got, [{ type: 'data', seq: 1, body: { yenPerKm: 230 } }]);
});

test('共有コードが違えば接続は失敗する', async () => {
  const { host, guest } = mk('aaa', 'bbb');
  const res = await Promise.allSettled([host.connect(), guest.connect()]);
  assert.ok(res.every((r) => r.status === 'rejected'));
});

test('認証前は Frame を送らない', async () => {
  const { host } = mk('x', 'x');
  let sent = 0;
  (host as any).api.send = () => sent++;
  host.send({ type: 'ping' });
  assert.equal(sent, 0);
});

test('discover が 8034(権限不足)で失敗したら、timeout を待たず理由つきで失敗する', async () => {
  const { guestApi } = fakeNet();
  guestApi.discover = () => queueMicrotask(() => guestApi.emit('onError', { op: 'discover', code: 8034 }));
  const guest = new NearbyTransport(guestApi, { role: 'guest', selfId: 'GUEST', pair: { peerId: 'HOST', secret: 's' }, nonce: () => 'ng', connectTimeoutMs: 5000 });
  const t0 = Date.now();
  await assert.rejects(() => guest.connect(), /missing-permission code=8034/);
  assert.ok(Date.now() - t0 < 1000);
});
